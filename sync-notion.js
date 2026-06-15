'use strict';
// sync-notion.js
// Pulls the LOD Matrix from Notion and rewrites the table body + JS labels dict in the HTML.
// Usage: set NOTION_API_KEY=secret_xxxx && node sync-notion.js
//
// Requires Node 18+ (built-in fetch). No npm install needed.
//
// To add a new row: add it to Notion, add its slug to SLUGS, add the slug to the right
// section in SECTIONS, and drop an image at images/{slug}.png.
// Never rename an existing slug — it's tied to images/{slug}.png.

const { readFileSync, writeFileSync } = require('fs');
const { join }                        = require('path');

const TOKEN = process.env.NOTION_API_KEY;
if (!TOKEN) {
  console.error('Error: NOTION_API_KEY environment variable is not set.');
  console.error('  set NOTION_API_KEY=secret_xxxx && node sync-notion.js');
  process.exit(1);
}

const LOD_DB = '257d8301-90ff-80a3-af08-f4eb5c0617df'; // 🟦 LOD Matrix
const HTML   = join(__dirname, 'index.html');

// ─── Slug map ─────────────────────────────────────────────────────────────────
// Key   = exact Notion "Plan Item" title (case-sensitive)
// Value = HTML data-slug (also the image filename: images/{slug}.png)
const SLUGS = {
  'Walls':                                                               'walls',
  'Floors':                                                              'floors',
  'Ceilings':                                                            'ceilings',
  'Roofs':                                                               'roofs',
  'Doors':                                                               'doors',
  'Windows / Openings':                                                  'windows',
  'Stairs / Elevators / Shafts':                                         'stairs',
  'Built-in Cabinetry / Counters':                                       'casework',
  'Major Appliances':                                                    'appliances',
  'Plumbing Fixtures':                                                   'plumbing',
  'Attached wall elements (shelves, mirrors)':                           'wall-elements',
  'Building Facade':                                                     'facade',
  'Attached Decks / Balconies':                                          'deck',
  'Columns / Posts':                                                     'columns',
  'Structural Elements (beams, exposed structure)':                      'beams',
  'Framing (joists, rafters, trusses)':                                  'framing',
  'Foundation Walls':                                                    'foundation',
  'Footings / Piers / Posts':                                            'footings',
  'Parapets / Chimneys':                                                 'parapets',
  'Skylights':                                                           'skylights',
  'Fixed Roof Equipment':                                                'roof-equipment',
  'Drains / Vents':                                                      'drains',
  'Large MEP Equipment (furnace, water heater, solar components, etc.)': 'mep',
  'Utility Panels & Meters':                                             'utility-panels',
  'Outlets / Switches / Jacks':                                          'outlets',
  'Controls (HVAC, security)':                                           'controls',
  'Ceiling Fixtures (lights, vents, sprinklers, etc)':                   'fixtures',
  'Piping / Ducting':                                                    'piping',
  'Building/Structure footprint':                                        'footprint',
  'Major Hardscape/Parking':                                             'hardscape',
  'Utilities (gas/elec/water meters)':                                   'utilities',
  'Utilities (Gas/Elec/Water Meters)':                                   'utilities', // alias until Notion title is lowercased
};

// ─── Display section config ────────────────────────────────────────────────────
// Controls section headers and row order in the HTML.
// The Notion "PPM Plan Type" field is for plan drawing types (different purpose) — not used here.
const SECTIONS = [
  { header: 'Architectural',     slugs: ['walls','floors','ceilings','roofs','doors','windows','stairs'] },
  { header: 'Interior elements', slugs: ['casework','appliances','plumbing','wall-elements'] },
  { header: 'Exterior elements', slugs: ['facade','deck'] },
  { header: 'Structural',        slugs: ['columns','beams','framing','foundation','footings'] },
  { header: 'Roof elements',     slugs: ['parapets','skylights','roof-equipment','drains'] },
  { header: 'MEP & equipment',   slugs: ['mep','utility-panels','outlets','controls','fixtures','piping'] },
  { header: 'Site',              slugs: ['footprint','hardscape','utilities'] },
];

// ─── Notion helpers ────────────────────────────────────────────────────────────
async function notionPost(path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function queryAll(dbId) {
  const pages = [];
  let cursor;
  do {
    const data = await notionPost(`/databases/${dbId}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function txt(prop) {
  const arr = prop?.rich_text ?? prop?.title ?? [];
  return arr.map(b => b.plain_text ?? '').join('');
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function c250cls(current) {
  if (current === '200') return 'c250-200';
  if (current === '300') return 'c250-300';
  return 'c250-unique';
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  process.stdout.write('Fetching Notion data… ');

  const lodPages = await queryAll(LOD_DB);
  console.log(`got ${lodPages.length} items.`);

  // Build a lookup: slug → item data (last write wins if duplicate slugs)
  const bySlug = {};
  const unmapped = [];

  for (const p of lodPages) {
    const titleProp = Object.values(p.properties).find(pr => pr.type === 'title');
    const planItem  = titleProp ? txt(titleProp) : '';
    if (!planItem) continue;

    const slug = SLUGS[planItem];
    if (!slug) { unmapped.push(planItem); continue; }

    bySlug[slug] = {
      label:   planItem,
      lod200:  txt(p.properties['LOD 200']),
      lod250:  txt(p.properties['LOD 250 (PPM Deliverable)']),
      lod300:  txt(p.properties['LOD 300']),
      current: p.properties['Current']?.select?.name ?? '250',
    };
  }

  // Build tbody and labels dict in SECTIONS order
  const warns = [];
  let tbody      = '\n';
  let totalRows  = 0;
  const labelLines = [];

  for (const section of SECTIONS) {
    tbody += `\n<tr class="cath"><td colspan="4">${esc(section.header)}</td></tr>\n`;
    const sectionLabels = [];

    for (const slug of section.slugs) {
      const item = bySlug[slug];
      if (!item) {
        warns.push(`"${slug}" is in SECTIONS but not found in Notion — row skipped.`);
        continue;
      }

      const cell200 = !item.lod200.trim() || /excluded/i.test(item.lod200)
        ? '<span class="cexc">Excluded from LOD 200.</span>'
        : esc(item.lod200);

      tbody += `<tr class="erow">`
             + `<td class="cel" data-slug="${slug}">`
             + `<div class="cel-inner">`
             + `<span class="caret"><i class="ti ti-chevron-right"></i></span>`
             + `${esc(item.label)}`
             + `</div></td>`
             + `<td class="c200">${cell200}</td>`
             + `<td class="c250 ${c250cls(item.current)}">${esc(item.lod250)}</td>`
             + `<td class="c300">${esc(item.lod300)}</td>`
             + `</tr>\n`;

      sectionLabels.push(`'${slug}':'${item.label.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
      totalRows++;
    }

    if (sectionLabels.length) labelLines.push(sectionLabels.join(','));
  }

  const labelsDict = `var labels = {\n    ${labelLines.join(',\n    ')}\n  };`;

  // Patch HTML
  let html = readFileSync(HTML, 'utf-8');
  const tbodyMatches = html.match(/<tbody>/g) ?? [];
  if (tbodyMatches.length !== 1) throw new Error(`Expected 1 <tbody>, found ${tbodyMatches.length}`);
  html = html.replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>${tbody}\n</tbody>`);
  html = html.replace(/var labels = \{[\s\S]*?\};/, labelsDict);
  writeFileSync(HTML, html, 'utf-8');

  console.log(`✓ Wrote ${totalRows} rows across ${SECTIONS.length} sections → ${HTML}`);

  if (unmapped.length) {
    console.warn('\nNotion items with no slug (ignored):');
    unmapped.forEach(n => console.warn(`  · "${n}"  ← add to SLUGS + SECTIONS if needed`));
  }
  if (warns.length) {
    console.warn('\nWarnings:');
    warns.forEach(w => console.warn('  ⚠', w));
  }
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });
