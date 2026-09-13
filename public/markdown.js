import { marked, Marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { renderDiagram } from '/diagrams.js';

const versions = new WeakMap();
const localSvg = href => /\.svg$/i.test(href) && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href);

export function renderMarkdown(node, text, { loadSvg, onLayout = update => update() } = {}) {
  const version = Symbol(); versions.set(node, version);
  const diagrams = [], renderer = new marked.Renderer();
  const placeholder = (kind, source, label = '') => {
    const id = diagrams.push({ kind, source, label }) - 1;
    return `<span data-diagram="${id}"></span>`;
  };
  renderer.html = () => '';
  renderer.code = function (token) {
    const language = (token.lang ?? '').trim().split(/\s+/)[0].toLowerCase();
    return ['mermaid', 'svg'].includes(language) ? placeholder(language, token.text) : marked.Renderer.prototype.code.call(this, token);
  };
  renderer.image = ({ href, text }) => localSvg(href) ? placeholder('asset', href, text) : '[Image — open in Codex]';
  renderer.link = function (token) {
    return localSvg(token.href) ? placeholder('asset', token.href, token.text) : marked.Renderer.prototype.link.call(this, token);
  };
  const parser = new Marked({ renderer, breaks: true, gfm: true, extensions: [{ name: 'svg', level: 'block',
    start: source => source.search(/^ {0,3}<svg[\s/>]/im),
    tokenizer(source) {
      if (!/^ {0,3}<svg[\s/>]/i.test(source)) return;
      let depth = 0;
      for (const match of source.matchAll(/<\/?svg\b[^>]*>/gi)) {
        depth += match[0].startsWith('</') ? -1 : /\/\s*>$/.test(match[0]) ? 0 : 1;
        if (depth === 0) return { type: 'svg', raw: source.slice(0, match.index + match[0].length) };
      }
    },
    renderer: token => placeholder('svg', token.raw),
  }] });
  node.innerHTML = DOMPurify.sanitize(parser.parse(text), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'span', 'hr', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'data-diagram'],
  });
  for (const link of node.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) link.removeAttribute('href');
    else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
  return Promise.all([...node.querySelectorAll('[data-diagram]')].map(target => renderDiagram(target, diagrams[Number(target.dataset.diagram)], loadSvg,
    () => versions.get(node) === version && node.contains(target), onLayout)));
}
