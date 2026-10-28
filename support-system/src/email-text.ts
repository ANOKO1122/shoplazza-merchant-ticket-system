import { compile, type FormatCallback } from 'html-to-text';

const visibleStyledContent: FormatCallback = (element, walk, builder) => {
  // Email preheaders commonly use inline CSS, including Outlook's mso-hide.
  const style = String(element.attribs?.style || '');
  if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\s*(?:!important\s*)?(?:;|$)/i.test(style)) {
    return;
  }

  // Reuse the tag's normal formatter without matching this style rule again.
  const { style: _style, ...attributes } = element.attribs;
  walk([{ ...element, attribs: attributes }], builder);
};

const convertEmailHtml = compile({
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(selector => ({
      selector,
      options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 2 },
    })),
    // Email tables provide layout; keep row order without padded grid columns.
    { selector: 'table', format: 'block', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: 'tr', format: 'block', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: 'td', format: 'inlineSurround', options: { suffix: ' ' } },
    { selector: 'th', format: 'inlineSurround', options: { suffix: ' ' } },
    { selector: '[style]', format: 'visibleStyledContent' },
    { selector: '[hidden]', format: 'skip' },
    { selector: 'head', format: 'skip' },
    { selector: 'script', format: 'skip' },
    { selector: 'style', format: 'skip' },
  ],
  formatters: { visibleStyledContent },
});

/** Derive the MIME text alternative without modifying the HTML email body. */
export function emailHtmlToText(html: string): string {
  return convertEmailHtml(html).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
