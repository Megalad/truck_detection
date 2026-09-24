// Violation notice PDF (Violations page -> "Download Ticket", admin only): a single A4 page
// laid out like a formal traffic notice - boxed form fields, notice number and a captioned
// evidence photo. Built entirely in the browser;
// jsPDF is loaded on demand so it never weighs down normal page loads.
import { CAMERAS } from './cameras';

const DIRECTION = { L: 'Inbound', R: 'Outbound' };

const asDate = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};
const fmtDate = (d) => (d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const fmtTime = (d) => (d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-');

const fmtKm = (km) => {
  const n = Number(km);
  if (km == null || km === '' || Number.isNaN(n)) return '-';
  const whole = Math.floor(n);
  return `KM ${whole}+${String(Math.round((n - whole) * 1000)).padStart(3, '0')}`;
};

// Evidence image -> data URL (jsPDF needs the bytes). null if it can't be loaded.
async function loadImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// GPS coordinates from the master camera list (served at /camera.json).
async function loadCoordinates(cameraId) {
  try {
    const json = await (await fetch('/camera.json')).json();
    const cam = (json?.data?.cctv || []).find((c) => (c.title || '').split(' ')[0] === cameraId);
    return cam ? `${Number(cam.latitude).toFixed(6)}, ${Number(cam.longitude).toFixed(6)}` : '-';
  } catch {
    return '-';
  }
}

/**
 * Generate and download the one-page notice for a violation.
 * @param row      a violation record from /api/violations
 * @param related  other violations with the same route_match_id (same truck, other cameras)
 * @param issuedBy admin username, printed as the person who generated the notice
 */
export async function downloadTicket(row, related = [], issuedBy = '') {
  const [{ jsPDF }, image, coords] = await Promise.all([
    import('jspdf'),
    loadImage(row.evidence_snapshot_url),
    loadCoordinates(row.camera_location),
  ]);

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 14, CW = W - 2 * M;
  const INK = [17, 24, 39], MUTED = [107, 114, 128], RULE = [156, 163, 175], ACCENT = [185, 28, 28];
  const camera = CAMERAS.find((c) => c.id === row.camera_location);
  const when = asDate(row.timestamp);
  const issued = new Date();

  const text = (str, x, y, { size = 9, bold = false, color = INK, align = 'left' } = {}) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(size).setTextColor(...color);
    doc.text(String(str), x, y, { align });
  };

  // Form cell: small caps label at the top, value below, thin border.
  const cell = (x, y, w, h, label, value, { big = false } = {}) => {
    doc.setDrawColor(...RULE).setLineWidth(0.25);
    doc.rect(x, y, w, h);
    text(label.toUpperCase(), x + 2, y + 3.6, { size: 6.2, bold: true, color: MUTED });
    const lines = doc.setFont('helvetica', 'bold').setFontSize(big ? 10.5 : 9.5).splitTextToSize(String(value ?? '-'), w - 4);
    text(lines[0] || '', x + 2, y + 8.6, { size: big ? 10.5 : 9.5, bold: true }); // one line per cell
  };

  // Section heading: numbered bar across the page.
  const heading = (n, title, y) => {
    doc.setFillColor(243, 244, 246);
    doc.rect(M, y, CW, 6, 'F');
    doc.setFillColor(...INK);
    doc.rect(M, y, 6, 6, 'F');
    text(String(n), M + 3, y + 4.2, { size: 8, bold: true, color: [255, 255, 255], align: 'center' });
    text(title.toUpperCase(), M + 9, y + 4.2, { size: 8, bold: true });
    return y + 8;
  };

  // --- Header ---------------------------------------------------------------
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, W, 3, 'F');
  text('DO DO VISION  |  SECTION 35 AUTOMATED ENFORCEMENT', M, 12, { size: 7.5, bold: true, color: MUTED });
  text('NOTICE OF TRAFFIC VIOLATION', M, 21, { size: 18, bold: true });
  text('Heavy vehicle in the restricted lane - Section 35', M, 27, { size: 9.5, color: MUTED });

  // Notice number box (top right)
  const bx = W - M - 58;
  doc.setDrawColor(...INK).setLineWidth(0.5);
  doc.rect(bx, 8, 58, 22);
  text('NOTICE NO.', bx + 3, 13, { size: 6.5, bold: true, color: MUTED });
  text(row.violation_id, bx + 3, 19, { size: 10, bold: true });
  doc.setLineWidth(0.2).line(bx, 22, bx + 58, 22);
  text('DATE OF ISSUE', bx + 3, 25.5, { size: 6.5, bold: true, color: MUTED });
  text(fmtDate(issued), bx + 55, 28.5, { size: 8.5, bold: true, align: 'right' });

  doc.setDrawColor(...INK).setLineWidth(0.6).line(M, 34, W - M, 34);
  let y = 39;

  // --- 1. Offence details ---------------------------------------------------
  y = heading(1, 'Offence details', y);
  const H = 11, third = CW / 3, quarter = CW / 4;
  cell(M, y, CW, H, 'Offence', 'Heavy vehicle (truck) driving in the restricted rightmost lane', { big: true });
  y += H;
  cell(M, y, quarter, H, 'Date of offence', fmtDate(when));
  cell(M + quarter, y, quarter, H, 'Time of offence', fmtTime(when));
  cell(M + 2 * quarter, y, quarter, H, 'Camera ID', row.camera_location);
  cell(M + 3 * quarter, y, quarter, H, 'KM marker', fmtKm(row.camera_km));
  y += H;
  cell(M, y, third, H, 'Location', camera ? camera.title : row.camera_location);
  cell(M + third, y, third, H, 'Route / Direction', `${row.camera_route || '-'} / ${DIRECTION[row.camera_direction] || row.camera_direction || '-'}`);
  cell(M + 2 * third, y, third, H, 'GPS coordinates', coords);
  y += H + 4;

  // --- 2. Photographic evidence ---------------------------------------------
  y = heading(2, 'Photographic evidence', y);
  // The full, uncropped 16:9 frame at page width (its burned-in camera timestamp is part
  // of the evidence).
  const imgW = CW, imgH = imgW * 9 / 16, ix = M;
  if (image) {
    doc.addImage(image, 'JPEG', ix, y, imgW, imgH);
  } else {
    doc.setFillColor(243, 244, 246).rect(ix, y, imgW, imgH, 'F');
    text('Evidence image unavailable', W / 2, y + imgH / 2, { size: 10, color: MUTED, align: 'center' });
  }
  doc.setDrawColor(...INK).setLineWidth(0.3).rect(ix, y, imgW, imgH);
  // Caption strip
  doc.setFillColor(...INK).rect(ix, y + imgH, imgW, 6, 'F');
  text(`CAMERA ${row.camera_location}   |   ${fmtDate(when)}  ${fmtTime(when)}   |   REF ${row.violation_id}`,
    ix + 3, y + imgH + 4.1, { size: 7, bold: true, color: [255, 255, 255] });
  y += imgH + 10;

  // --- 3. Detection record --------------------------------------------------
  y = heading(3, 'Detection record', y);
  cell(M, y, CW, H, 'Detection method', 'AI video analysis - YOLO11 truck detection with BoT-SORT tracking');
  y += H;
  if (related.length) {
    const seen = related.slice(0, 3)
      .map((r) => `${r.camera_location} ${fmtTime(asDate(r.timestamp))}`)
      .join('   |   ') + (related.length > 3 ? `   (+${related.length - 3} more)` : '');
    cell(M, y, CW, H, 'Same vehicle also recorded at', seen);
    y += H;
  }

  // --- Footer -------------------------------------------------------------------
  doc.setDrawColor(...RULE).setLineWidth(0.2).line(M, 283, W - M, 283);
  text('Generated from an automated detection record. Evidence retained under the notice number above.', M, 287, { size: 6.8, color: MUTED });
  text(`Generated ${fmtDate(issued)} ${fmtTime(issued)}${issuedBy ? ` by ${issuedBy}` : ''}  |  Record #${row.id}`,
    W - M, 287, { size: 6.8, color: MUTED, align: 'right' });
  doc.setFillColor(...ACCENT).rect(0, 294, W, 3, 'F');

  doc.save(`ticket_${row.violation_id}.pdf`);
}
