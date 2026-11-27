// ---------- GoSurf (waves) ----------
export function parseGoSurf(text, dateDMY) {
  const start = text.indexOf(dateDMY);
  if (start < 0) throw new Error('GoSurf: date block not found');
  let block = text.slice(start);
  const next = block.slice(10).search(/\d{2}\/\d{2}\/\d{4}/);
  if (next > 0) block = block.slice(0, next + 10);
  const rows = {};
  const re = /\n(\d{2})\s*\n[\s\S]*?\n\s*(?:(\d+)\s*-\s*(\d+)\s*ס״מ|(פלטה))[^\n]*\n\s*(\d+)\s*קמ״ש\s*([^\d\n]+?)\s*(\d+)\s*\n\s*ס״מ\s*([\d.]+)\s*\n\s*שניות\s*\n\s*([^\n]+)/g;
  let m;
  while ((m = re.exec(block))) {
    const h = +m[1];
    rows[h] = { wave: m[4] ? [0, 0] : [+m[2], +m[3]], swellCm: +m[7], period: +m[8], swellDir: m[9].trim() };
  }
  if (!Object.keys(rows).length) throw new Error('GoSurf: no rows parsed');
  const sm = block.match(/תחזית גלים ומצב הים[^\n]*?-\s*([^\n]+)/);
  const summary = sm ? sm[1].replace(/☀️.*$/, '').replace(/צבע הדגל.*$/, '').trim() : '';
  return { ok: true, rows, summary };
}

