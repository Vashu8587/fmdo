// SQLite storage for B2B licensing applications.
// File-based DB (data/fmdo.db) — no external service needed, works locally and on the VPS.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'fmdo.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    plan          TEXT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL,
    phone         TEXT NOT NULL,
    address       TEXT NOT NULL,
    pincode       TEXT NOT NULL,
    start_date    TEXT NOT NULL,
    end_date      TEXT NOT NULL,
    yt_channel    TEXT,
    yt_link       TEXT,
    signature_file TEXT,
    aadhaar_front  TEXT,
    aadhaar_back   TEXT,
    payment_status TEXT DEFAULT 'pending',
    order_id       TEXT,
    payment_id     TEXT,
    created_at     TEXT NOT NULL
  );
`);

const insertApplication = db.prepare(`
  INSERT INTO applications
    (plan, name, email, phone, address, pincode, start_date, end_date,
     yt_channel, yt_link, signature_file, aadhaar_front, aadhaar_back, created_at)
  VALUES
    (@plan, @name, @email, @phone, @address, @pincode, @start_date, @end_date,
     @yt_channel, @yt_link, @signature_file, @aadhaar_front, @aadhaar_back, @created_at)
`);

const setOrderId = db.prepare(`UPDATE applications SET order_id = ? WHERE id = ?`);
const markPaid = db.prepare(
  `UPDATE applications SET payment_status = 'paid', payment_id = ? WHERE order_id = ?`
);
const getById = db.prepare(`SELECT * FROM applications WHERE id = ?`);

module.exports = {
  createApplication(data) {
    const info = insertApplication.run({
      plan: data.plan || null,
      name: data.name,
      email: data.email,
      phone: data.phone,
      address: data.address,
      pincode: data.pincode,
      start_date: data.start_date,
      end_date: data.end_date,
      yt_channel: data.yt_channel || null,
      yt_link: data.yt_link || null,
      signature_file: data.signature_file || null,
      aadhaar_front: data.aadhaar_front || null,
      aadhaar_back: data.aadhaar_back || null,
      created_at: new Date().toISOString(),
    });
    return info.lastInsertRowid;
  },
  attachOrder(applicationId, orderId) {
    setOrderId.run(orderId, applicationId);
  },
  markPaidByOrder(orderId, paymentId) {
    markPaid.run(paymentId, orderId);
  },
  getApplication(id) {
    return getById.get(id);
  },
};
