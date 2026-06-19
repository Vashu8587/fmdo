// FMDO landing page server
// Serves the static site now; ready to grow into a backend (API routes) later.

require('dotenv').config();
const express = require('express');
const path = require('path');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
const HOST = '0.0.0.0';                       // listen on all interfaces (LAN-accessible)
const PORT = process.env.PORT || 8080;

app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --- API routes ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'fmdo', time: new Date().toISOString() });
});

// Create Razorpay order server-side (secret key never leaves the server)
app.post('/api/create-order', async (req, res) => {
  const { plan } = req.body;

  const plans = {
    artist_pro: { amount: 239900, currency: 'INR', description: 'FMDO Artist Pro – Annual Plan' },
    starter:    { amount:  48900, currency: 'INR', description: 'FMDO Starter – Per Release'    },
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
