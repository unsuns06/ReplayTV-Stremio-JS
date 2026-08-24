/** The two MPD reads this addon needs, done with scanning instead of a DOM.
 *
 * ponytail: no XML parser dependency — the addon only ever asks a manifest two
 * questions ("what PSSH boxes are in it" and "what does ContentProtection
 * say"), and both are attribute/child lookups on one element type. Bring in a
 * real parser the day something needs to rewrite a manifest.
 */

/** Attribute value by local name, from a raw attribute string. */
function attr(attrs, localName) {
  const re = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${localName}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = attrs.match(re);
  return m ? (m[2] ?? m[3]) : null;
}

const CONTENT_PROTECTION_RE =
  /<(?:[\w.-]+:)?ContentProtection\b([^>]*?)\/>|<(?:[\w.-]+:)?ContentProtection\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?ContentProtection>/gi;

const PSSH_ELEMENT_RE = /<(?:[\w.-]+:)?pssh\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?pssh>/gi;
const PSSH_ATTRIBUTE_RE = /(?:^|\s)(?:[\w.-]+:)?pssh\s*=\s*("([^"]*)"|'([^']*)')/gi;

/** Every ContentProtection element as `{ attrs, body }`. */
export function iterContentProtection(xml) {
  const out = [];
  for (const m of xml.matchAll(CONTENT_PROTECTION_RE)) {
    out.push({ attrs: m[1] ?? m[2] ?? '', body: m[3] ?? '' });
  }
  return out;
}

/** Every PSSH payload in the document, as `{ text, source, parent }`. */
export function iterPsshText(xml) {
  const out = [];
  for (const { attrs, body } of iterContentProtection(xml)) {
    for (const m of attrs.matchAll(PSSH_ATTRIBUTE_RE)) {
      out.push({ text: m[2] ?? m[3], source: 'attribute', parent: 'ContentProtection' });
    }
    for (const m of body.matchAll(PSSH_ELEMENT_RE)) {
      out.push({ text: m[1].trim(), source: 'element', parent: 'ContentProtection' });
    }
  }
  // PSSH boxes outside a ContentProtection element are unusual but legal.
  for (const m of xml.matchAll(PSSH_ELEMENT_RE)) {
    const text = m[1].trim();
    if (text && !out.some((r) => r.text === text)) {
      out.push({ text, source: 'element', parent: 'MPD' });
    }
  }
  return out.filter((r) => r.text);
}

export { attr as xmlAttr };
