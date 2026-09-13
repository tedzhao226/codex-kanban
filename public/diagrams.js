import DOMPurify from '/vendor/purify.js';

let mermaidPromise, sequence = 0;

export function svgImage(source, label) {
  if (source.length > 1024 * 1024) throw new Error('SVG previews must be 1 MB or smaller.');
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('This is not a complete, valid SVG.');
  const svg = DOMPurify.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM: true,
    FORBID_TAGS: ['foreignObject', 'script', 'a', 'image', 'animate', 'animateMotion', 'animateTransform', 'set'] }).querySelector('svg');
  if (!svg) throw new Error('No SVG content remains after sanitizing.');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  for (const element of svg.querySelectorAll('[href], [xlink\\:href]')) {
    for (const attribute of ['href', 'xlink:href']) if (element.hasAttribute(attribute) && !element.getAttribute(attribute).startsWith('#')) element.removeAttribute(attribute);
  }
  const image = new Image();
  image.alt = label;
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  return image;
}

export async function mermaidSvg(source) {
  if (source.length > 50000) throw new Error('Mermaid previews must be 50,000 characters or smaller.');
  mermaidPromise ??= import('/vendor/mermaid/mermaid.esm.min.mjs').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'dark',
      htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: 'Arial, sans-serif', maxTextSize: 50000, maxEdges: 500,
      secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart', 'themeCSS', 'themeVariables', 'dompurifyConfig', 'fontFamily', 'altFontFamily'] });
    return mermaid;
  });
  const mermaid = await mermaidPromise;
  const stage = document.createElement('div');
  stage.className = 'diagram-render-stage';
  document.body.append(stage);
  try { return (await mermaid.render(`kanban-diagram-${++sequence}`, source, stage)).svg; }
  finally { stage.remove(); }
}

export async function renderDiagram(target, diagram, loadSvg, current, onLayout) {
  const source = document.createElement('pre'), code = document.createElement('code');
  code.textContent = diagram.source; source.append(code);
  const details = document.createElement('details'), summary = document.createElement('summary');
  summary.textContent = diagram.kind === 'asset' ? 'SVG file' : 'Source'; details.append(summary, source);
  const status = document.createElement('span');
  status.className = 'diagram-status'; status.textContent = 'Rendering diagram…';
  target.className = 'diagram'; target.append(status, details);
  try {
    let svg = diagram.source;
    if (diagram.kind === 'mermaid') svg = await mermaidSvg(svg);
    else if (diagram.kind === 'asset') {
      if (!loadSvg) throw new Error('Open this SVG from its task’s conversation.');
      svg = await loadSvg(svg);
    }
    if (!current()) return;
    const image = svgImage(svg, diagram.label || (diagram.kind === 'mermaid' ? 'Mermaid diagram' : 'SVG diagram'));
    await image.decode();
    if (!current()) return;
    const preview = document.createElement('span');
    preview.className = 'diagram-preview'; preview.append(image); onLayout(() => status.replaceWith(preview));
  } catch (error) {
    if (!current()) return;
    onLayout(() => {
      status.textContent = `Diagram preview unavailable: ${error.message}`;
      status.classList.add('diagram-error'); details.open = true;
    });
  }
}
