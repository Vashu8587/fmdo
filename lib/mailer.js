// Email delivery via Gmail SMTP (nodemailer).
//
// IMPORTANT: Gmail rejects normal account passwords over SMTP. GMAIL_PASS must be a
// 16-character App Password (Google Account -> Security -> 2-Step Verification -> App passwords).
// If GMAIL_USER / GMAIL_PASS are unset, sending is skipped (logged) so the app still works.

const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || GMAIL_USER;

let transporter = null;
if (GMAIL_USER && GMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
} else {
  console.warn('[mailer] GMAIL_USER/GMAIL_PASS not set — emails will be skipped.');
}

/**
 * Send the licensing letter to the applicant and a full copy (letter + uploads) to the admin.
 * @param {object} app  application data
 * @param {Buffer} letterDoc  generated B2B letter .docx
 * @param {Array<{filename:string, path:string}>} adminAttachments  e.g. Aadhaar copies
 */
async function sendApplicationEmails(app, letterDoc, adminAttachments = []) {
  if (!transporter) {
    console.warn(`[mailer] skipped emails for application ${app.id} (no SMTP creds).`);
    return { sent: false, reason: 'no-smtp-credentials' };
  }

  const safeName = String(app.name).replace(/[^a-z0-9]+/gi, '_');
  const letterAttachment = {
    filename: `B2B_Letter_${safeName}.docx`,
    content: letterDoc,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };

  // 1) To the applicant — ONLY the document (brief covering note, no form details).
  const userMail = transporter.sendMail({
    from: `"FM Digital Official" <${GMAIL_USER}>`,
    to: app.email,
    subject: 'Your FM Digital Official B2B Licensing Letter',
    text:
      `Dear ${app.name},\n\n` +
      `Please find your B2B licensing letter attached.\n\n` +
      `Regards,\nFM Digital Official Team`,
    attachments: [letterAttachment],
  });

  // 2) To admin — letter + full details + Aadhaar/signature copies.
  const details = [
    `New B2B licensing application #${app.id}`,
    '',
    `Plan:        ${app.plan || '-'}`,
    `Name:        ${app.name}`,
    `Email:       ${app.email}`,
    `Phone:       ${app.phone}`,
    `Address:     ${app.address}`,
    `Pincode:     ${app.pincode}`,
    `Start date:  ${app.start_date}`,
    `End date:    ${app.end_date}`,
    `YT channel:  ${app.yt_channel || '-'}`,
    `YT link:     ${app.yt_link || '-'}`,
    '',
    `Submitted:   ${new Date().toISOString()}`,
  ].join('\n');

  const adminMail = transporter.sendMail({
    from: `"FMDO Applications" <${GMAIL_USER}>`,
    to: ADMIN_EMAIL,
    subject: `New B2B Application — ${app.name} (#${app.id})`,
    text: details,
    attachments: [letterAttachment, ...adminAttachments],
  });

  await Promise.all([userMail, adminMail]);
  return { sent: true };
}

module.exports = { sendApplicationEmails, transporter };
