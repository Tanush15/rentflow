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

function tablePdf({ title, subtitle, headers, rows, widths }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const margin = 36;
      const pageWidth = doc.page.width;
      const bottom = doc.page.height - margin - 18;
      const usable = pageWidth - margin * 2;
      const totalWidth = widths.reduce((a, b) => a + b, 0);
      const cols = widths.map((w) => (w / totalWidth) * usable);

      doc.rect(0, 0, pageWidth, 88).fill('#1f4d3d');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('RentFlow', margin, 16);
      doc.font('Helvetica').fontSize(9).text(subtitle || 'Family Rent Management', margin, 40);
      doc.font('Helvetica-Bold').fontSize(13).text(title, margin, 58);
      doc.font('Helvetica').fontSize(8).text(
        `Generated ${new Date().toLocaleString('en-IN')}`,
        pageWidth - margin - 230, 60, { width: 230, align: 'right' }
      );

      let y = 106;
      const drawHead = () => {
        doc.rect(margin, y - 4, usable, 20).fill('#e8f1ec');
        doc.fillColor('#1d2b25').font('Helvetica-Bold').fontSize(8.5);
        let x = margin;
        headers.forEach((h, i) => {
          doc.text(h, x + 4, y, { width: cols[i] - 8, height: 11, ellipsis: true });
          x += cols[i];
        });
        y += 22;
      };
      drawHead();

      rows.forEach((row, idx) => {
        const cells = row.map((c) => (c === null || c === undefined || c === '' ? '-' : String(c)));
        const heights = cells.map((cell, i) =>
          doc.heightOfString(cell, { width: cols[i] - 8, font: 'Helvetica', fontSize: 8 })
        );
        const rowH = Math.max(15, Math.min(70, Math.max(...heights) + 7));
        if (y + rowH > bottom) {
          doc.addPage();
          y = margin + 8;
          drawHead();
        }
        if (idx % 2 === 1) doc.rect(margin, y - 3, usable, rowH).fill('#f7faf8');
        doc.fillColor('#222222').font('Helvetica').fontSize(8);
        let x = margin;
        cells.forEach((cell, i) => {
          doc.text(cell, x + 4, y, { width: cols[i] - 8, height: rowH - 2, ellipsis: true });
          x += cols[i];
        });
        y += rowH;
      });

      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        doc.fillColor('#888888').font('Helvetica').fontSize(8)
          .text(`Page ${i + 1} of ${range.count}`, margin, doc.page.height - 22, { width: 220 });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function paymentsPdf(payments) {
  return tablePdf({
    title: 'Rent payments',
    subtitle: 'RentFlow · Family Rent Management',
    headers: ['Receipt', 'Tenant', 'Room', 'Month', 'Mode', 'Rent', 'Extra', 'Due adj.', 'Received', 'Pending', 'Date'],
    widths: [105, 85, 40, 55, 45, 55, 50, 50, 65, 60, 65],
    rows: payments.map((p) => [
      p.receipt_no || '-',
      p.tenant_name || '-',
      p.room_no || '-',
      monthLabel(p.month),
      String(p.mode || 'cash').toUpperCase(),
      inr(p.rent_amount),
      p.extra_charges ? inr(p.extra_charges) : '-',
      p.dues_adjusted ? inr(p.dues_adjusted) : '-',
      inr(p.amount),
      p.remaining ? inr(p.remaining) : 'Clear',
      p.created_at ? new Date(p.created_at).toLocaleDateString('en-IN') : '-',
    ]),
  });
}

function activityPdf(activity) {
  return tablePdf({
    title: 'Family activity log',
    subtitle: 'RentFlow · Every change, who made it and when',
    headers: ['When', 'Who', 'Action', 'Area', 'Record', 'What changed'],
    widths: [88, 80, 55, 60, 45, 345],
    rows: activity.map((a) => [
      a.created_at ? new Date(a.created_at).toLocaleString('en-IN') : '-',
      a.user_name || 'System',
      a.action || '-',
      a.entity || '-',
      a.entity_id ? `#${a.entity_id}` : '-',
      a.details || '-',
    ]),
  });
}

// Full rent ledger for one tenant: every payment and every due, newest first.
function tenantLedgerPdf(detail) {
  const t = detail.tenant || {};
  const rows = [
    ...(detail.payments || []).map((p) => ({
      month: p.month,
      type: 'Payment',
      details: `${p.receipt_no || '-'} · ${String(p.mode || 'cash').toUpperCase()}`,
      amount: p.amount,
      status: p.remaining ? `Pending ${inr(p.remaining)}` : 'Clear',
    })),
    ...(detail.dues || []).map((d) => ({
      month: d.month,
      type: d.settled ? 'Settled due' : 'Due',
      details: d.reason || '-',
      amount: d.amount,
      status: d.settled ? 'Settled' : 'Pending',
    })),
  ].sort((a, b) => String(b.month).localeCompare(String(a.month)));

  return tablePdf({
    title: `Tenant ledger · ${t.name || '-'}`,
    subtitle: `Room ${t.room_no || '-'} · Paid ${inr(detail.paid_total)} · Outstanding ${inr(detail.due_total)} · RentFlow`,
    headers: ['Month', 'Type', 'Details', 'Amount', 'Status'],
    widths: [70, 80, 300, 80, 100],
    rows: rows.length
      ? rows.map((r) => [monthLabel(r.month), r.type, r.details, inr(r.amount), r.status])
      : [['-', '-', 'No payments or dues recorded yet', '-', '-']],
  });
}

// One-month collection summary with the pending detail for every tenant.
function monthSummaryPdf(report) {
  const pending = report.pending || [];
  return tablePdf({
    title: `Monthly summary · ${monthLabel(report.month)}`,
    subtitle: `Collected ${inr(report.collected)} of ${inr(report.expected)} expected · Pending ${inr(report.pending_total)} · RentFlow`,
    headers: ['Tenant', 'Room', 'Rent', 'Electricity', 'Paid', 'Old dues', 'Pending'],
    widths: [120, 55, 70, 80, 70, 70, 80],
    rows: pending.length
      ? pending.map((p) => [
        p.name,
        p.room_no,
        inr(p.rent),
        inr(p.electricity_bill),
        inr(p.paid),
        inr(p.dues),
        inr(p.pending),
      ])
      : [['All clear', '-', '-', '-', '-', '-', inr(0)]],
  });
}

module.exports = { receiptPdf, paymentsPdf, activityPdf, tenantLedgerPdf, monthSummaryPdf };
