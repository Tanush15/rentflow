'use strict';

const PDFDocument = require('pdfkit');
const { monthLabel, inr } = require('../utils');

function receiptPdf(payment, ctx) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.rect(0, 0, 595, 110).fill('#1f4d3d');
      doc.fillColor('#ffffff').fontSize(24).font('Helvetica-Bold').text('RentFlow', 50, 38);
      doc.fontSize(10).font('Helvetica').text('Family Rent Management', 50, 70);
      doc.fontSize(10).text('RENT RECEIPT', 420, 45, { align: 'right', width: 125 });

      doc.fillColor('#222222');
      let y = 140;
      doc.fontSize(16).font('Helvetica-Bold').text(`Receipt ${payment.receipt_no || ''}`, 50, y);
      y += 30;

      const row = (label, value) => {
        doc.font('Helvetica').fontSize(10).fillColor('#777777').text(label, 50, y, { width: 120 });
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#222222').text(String(value || '-'), 175, y - 2, { width: 370 });
        y += 24;
      };

      row('Tenant', ctx.tenantName);
      row('Room', ctx.roomNo);
      row('Month', monthLabel(payment.month));
      row('Date', new Date(payment.created_at).toLocaleDateString('en-IN'));
      row('Payment mode', String(payment.mode || 'cash').toUpperCase());
      if (payment.reference) row('Reference', payment.reference);

      y += 8;
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#dddddd').stroke();
      y += 20;

      const moneyRow = (label, value, bold = false) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(11).fillColor('#333333').text(label, 50, y, { width: 300 });
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(11).fillColor('#222222').text(inr(value), 360, y, { align: 'right', width: 185 });
        y += 22;
      };

      moneyRow('Monthly rent', payment.rent_amount);
      if (payment.extra_charges) moneyRow('Extra charges', payment.extra_charges);
      if (payment.dues_adjusted) moneyRow('Old dues adjusted', payment.dues_adjusted);
      y += 6;
      moneyRow('Amount received', payment.amount, true);
      if (payment.remaining) moneyRow('Still pending', payment.remaining);

      y += 20;
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#dddddd').stroke();
      y += 24;
      doc.fontSize(10).font('Helvetica').fillColor('#666666');
      if (payment.note) doc.text(`Note: ${payment.note}`, 50, y, { width: 490 });
      y += 30;
      doc.text(`Received by: ${ctx.receivedBy || 'Family Admin'}`, 50, y, { width: 300 });
      doc.text('Thank you! - RentFlow', 50, y + 40, { width: 300, align: 'left' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { receiptPdf };
