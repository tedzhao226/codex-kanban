import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const renderer = new marked.Renderer();
renderer.html = () => '';
renderer.image = () => '[Image — open in Codex]';

export function renderMarkdown(node, text) {
  node.innerHTML = DOMPurify.sanitize(marked.parse(text, { renderer, breaks: true, gfm: true }), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'hr', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'start'],
  });
  for (const link of node.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) link.removeAttribute('href');
    else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
}
