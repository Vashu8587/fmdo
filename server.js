// FMDO landing page server
// Serves the static site now; ready to grow into a backend (API routes) later.

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const multer = require('multer');

const db = require('./lib/db');
const { generateLetterDocx } = require('./lib/letter');
const { sendApplicationEmails } = require('./lib/mailer');

const app = express();
const HOST = process.env.HOST || '0.0.0.0';   // listen on all interfaces (LAN-accessible); set HOST=127.0.0.1 behind a reverse proxy
const PORT = process.env.PORT || 8080;

app.use(express.json());

// --- File uploads (signature + Aadhaar front/back) ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const safe = file.fieldname + '_' + Date.now() + '_' +
      Math.random().toString(36).slice(2, 8) +
      path.extname(file.originalname).toLowerCase();
    cb(null, safe);
  },
});

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },   // 5 MB per file
  fileFilter: (req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPG, PNG, WEBP or PDF files are allowed'));
  },
});

const applicationUpload = upload.fields([
  { name: 'signature', maxCount: 1 },
  { name: 'aadhaar_front', maxCount: 1 },
  { name: 'aadhaar_back', maxCount: 1 },
]);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});




// --- API routes ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'fmdo', time: new Date().toISOString() });
});

// Submit a B2B licensing application: store it, generate the letter PDF, email it out.
app.post('/api/submit-application', (req, res) => {
  applicationUpload(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message });
    }
    try {
      const b = req.body || {};
      const required = ['name', 'email', 'phone', 'address', 'pincode', 'start_date', 'end_date'];
      for (const f of required) {
        if (!b[f] || !String(b[f]).trim()) {
          return res.status(400).json({ error: `Missing required field: ${f}` });
        }
      }
      if (!/^\S+@\S+\.\S+$/.test(b.email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }

      const files = req.files || {};
      const sigFile = files.signature && files.signature[0];
      const frontFile = files.aadhaar_front && files.aadhaar_front[0];
      const backFile = files.aadhaar_back && files.aadhaar_back[0];

      const appData = {
        plan: b.plan,
        name: b.name.trim(),
        email: b.email.trim(),
        phone: b.phone.trim(),
        address: b.address.trim(),
        pincode: b.pincode.trim(),
        start_date: b.start_date.trim(),
        end_date: b.end_date.trim(),
        yt_channel: (b.yt_channel || '').trim(),
        yt_link: (b.yt_link || '').trim(),
        signature_file: sigFile ? sigFile.filename : null,
        aadhaar_front: frontFile ? frontFile.filename : null,
        aadhaar_back: backFile ? backFile.filename : null,
      };

      

      const id = db.createApplication(appData);
      const fullApp = { id, ...appData };

      // Fill the B2B Letter.docx template (embed signature image if it's an image file).
      let sigBuffer = null;
      let sigExt = 'png';
      if (sigFile && sigFile.mimetype !== 'application/pdf') {
        try {
          sigBuffer = fs.readFileSync(sigFile.path);
          sigExt = /jpe?g/i.test(sigFile.mimetype) ? 'jpg' : 'png';
        } catch (_) {}
      }
      const letterDoc = generateLetterDocx(fullApp, sigBuffer, sigExt);

      // Email: applicant gets ONLY the letter; admin gets letter + details + Aadhaar copies.
      const adminAttachments = [frontFile, backFile, sigFile]
        .filter(Boolean)
        .map((f) => ({ filename: f.originalname, path: f.path }));

      // Respond immediately so Save feels instant; send the emails in the background.
      res.json({ applicationId: id });

      sendApplicationEmails(fullApp, letterDoc, adminAttachments)
        .then((r) => { if (!r.sent) console.warn('Emails not sent for application', id, r.reason); })
        .catch((mailErr) => console.error('Email sending failed for application', id, mailErr.message));
    } catch (err) {
      console.error('submit-application failed:', err);
      res.status(500).json({ error: 'Could not submit application' });
    }
  });
});

// Create Razorpay order server-side (secret key never leaves the server)
app.post('/api/create-order', async (req, res) => {
  const { plan, applicationId } = req.body;

  const plans = {
    artist_pro: { amount: 239900, currency: 'INR', description: 'FMDO Artist Pro – Annual Plan' },
    starter:    { amount:  48900, currency: 'INR', description: 'FMDO Starter – Per Release'    }, // ₹489
  };

  const selected = plans[plan];
  if (!selected) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const order = await razorpay.orders.create({
      amount: selected.amount,
      currency: selected.currency,
      receipt: `fmdo_${plan}_${Date.now()}`,
      notes: { plan, description: selected.description },
    });
    if (applicationId) {
      try { db.attachOrder(applicationId, order.id); } catch (_) {}
    }
    res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('Razorpay order creation failed:', err);
    res.status(500).json({ error: 'Could not create payment order' });
  }
});

// Verify payment signature after success (optional but recommended)
app.post('/api/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected === razorpay_signature) {
    try { db.markPaidByOrder(razorpay_order_id, razorpay_payment_id); } catch (_) {}
    res.json({ verified: true });
  } else {
    res.status(400).json({ verified: false, error: 'Signature mismatch' });
  }
});

// --- Static site (index.html + Brand logo/, DSPs/, etc.) ---
app.use(express.static(__dirname));

app.listen(PORT, HOST, () => {
  console.log(`FMDO site running:`);
  console.log(`  local:   http://localhost:${PORT}`);
  console.log(`  network: http://192.168.1.217:${PORT}`);
});
