// Fills the exact "B2B Letter.docx" template with the applicant's details and signature,
// preserving the original Word formatting. Output is a .docx (no PDF conversion).
//
// The template has clean, separable text runs:
//   "Label" x3  -> applicant name      "Address" -> address      "Pin Code" -> pincode line
//   "Date: 03-04-2025 " -> issue date
//   date triples "03"/"th"/" April 2025|2027" -> start date (x2) and end date (x1)
// The signature image is injected as an inline picture right before "Signature or stamp".

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const TEMPLATE_PATH = path.join(__dirname, '..', 'B2B Letter.docx');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// "2026-04-09" -> "9th April 2026"
function longDate(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  if (!y || !m || !d) return String(isoDate);
  return `${ordinal(d)} ${MONTHS[m - 1]} ${y}`;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Replace the Nth (1-based) occurrence of `find` with `repl`.
function replaceNth(str, find, repl, n) {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = str.indexOf(find, idx + 1);
    if (idx === -1) return str;
  }
  return str.slice(0, idx) + repl + str.slice(idx + find.length);
}

// Read intrinsic pixel dimensions from a PNG or JPEG buffer (best-effort).
function imageSize(buf) {
  // PNG: signature 8 bytes, then IHDR with width@16, height@20 (big-endian).
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: scan for SOF0/1/2/3 markers.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
      }
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

// Build the <w:p> paragraph that renders the inline signature image.
function signatureParagraphXml(relId, buf) {
  const EMU_PER_MM = 36000;
  const maxWidthEmu = 45 * EMU_PER_MM;            // ~45 mm wide signature box
  const size = imageSize(buf);
  let cx = maxWidthEmu;
  let cy = Math.round(maxWidthEmu * 0.5);
  if (size && size.w > 0) {
    cy = Math.round(maxWidthEmu * (size.h / size.w));
  }
  return (
    '<w:p><w:r><w:rPr><w:noProof/></w:rPr><w:drawing>' +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:docPr id="101" name="Signature"/>' +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic><pic:nvPicPr><pic:cNvPr id="101" name="Signature"/><pic:cNvPicPr/></pic:nvPicPr>' +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/>' +
    `<a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  );
}

/**
 * Generate the filled B2B letter as a .docx buffer.
 * @param {object} app  application data (name, address, pincode, start_date, end_date)
 * @param {Buffer|null} signatureBuffer  PNG/JPEG signature; null skips the image
 * @param {string} signatureExt  'png' | 'jpg' | 'jpeg' (defaults to png)
 * @returns {Buffer}
 */
function generateLetterDocx(app, signatureBuffer, signatureExt = 'png') {
  const zip = new PizZip(fs.readFileSync(TEMPLATE_PATH));
  let doc = zip.file('word/document.xml').asText();

  const name = xmlEscape(app.name);
  const address = xmlEscape(String(app.address).replace(/\s*[\r\n]+\s*/g, ', '));
  const pincode = xmlEscape(app.pincode);
  const start = xmlEscape(longDate(app.start_date));
  const end = xmlEscape(longDate(app.end_date));

  const today = new Date();
  const issueDate = `${String(today.getDate()).padStart(2, '0')}-` +
    `${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;

  // --- Text fields ---
  doc = doc.split('>Label<').join(`>${name}<`);              // name (3 occurrences)
  doc = doc.replace('>Address<', `>${address}<`);
  doc = doc.replace('>Pin Code<', `>Pin Code - ${pincode}<`);
  doc = doc.replace('>Date: 03-04-2025 <', `>Date: ${xmlEscape(issueDate)} <`);

  // --- Dates: collapse each "03"/"th"/" April YYYY" triple into one value ---
  // order in doc: start date, valid-from (=start), valid-till (=end).
  // Replace in REVERSE order so an earlier replacement doesn't shift later occurrence indices.
  doc = replaceNth(doc, '>03<', `>${end}<`, 3);     // valid till -> end date
  doc = replaceNth(doc, '>03<', `>${start}<`, 2);   // valid from -> start date
  doc = replaceNth(doc, '>03<', `>${start}<`, 1);   // start date -> start date
  doc = doc.split('>th<').join('><');                        // drop the 3 ordinal "th" runs
  doc = doc.split('> April 2025<').join('><');               // drop trailing " April 2025" (x2)
  doc = doc.replace('> April 2027<', '><');                  // drop trailing " April 2027"

  // --- Signature image (optional) ---
  if (signatureBuffer && signatureBuffer.length) {
    const ext = /jpe?g/i.test(signatureExt) ? 'jpeg' : 'png';
    const mediaName = `media/signature.${ext === 'jpeg' ? 'jpg' : 'png'}`;

    // 1) add image bytes
    zip.file(`word/${mediaName}`, signatureBuffer);

    // 2) ensure content-type default for the extension
    let ct = zip.file('[Content_Types].xml').asText();
    const extKey = ext === 'jpeg' ? 'jpg' : 'png';
    const mime = ext === 'jpeg' ? 'image/jpeg' : 'image/png';
    if (!ct.includes(`Extension="${extKey}"`)) {
      ct = ct.replace('</Types>',
        `<Default ContentType="${mime}" Extension="${extKey}"/></Types>`);
      zip.file('[Content_Types].xml', ct);
    }

    // 3) add a relationship with a fresh rId
    let rels = zip.file('word/_rels/document.xml.rels').asText();
    const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
    const relId = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
    rels = rels.replace('</Relationships>',
      `<Relationship Id="${relId}" ` +
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ` +
      `Target="${mediaName}"/></Relationships>`);
    zip.file('word/_rels/document.xml.rels', rels);

    // 4) insert the image paragraph immediately before the "Signature or stamp" paragraph
    const sigIdx = doc.indexOf('Signature or stamp');
    if (sigIdx !== -1) {
      const pStart = doc.lastIndexOf('<w:p ', sigIdx);
      const pStart2 = doc.lastIndexOf('<w:p>', sigIdx);
      const insertAt = Math.max(pStart, pStart2);
      if (insertAt !== -1) {
        doc = doc.slice(0, insertAt) +
          signatureParagraphXml(relId, signatureBuffer) +
          doc.slice(insertAt);
      }
    }
  }

  zip.file('word/document.xml', doc);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { generateLetterDocx, longDate };
