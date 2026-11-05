// A chat message's text, rendered as GitHub-flavoured Markdown. Raw HTML in it
// is shown as the text it is, never rendered; code blocks are highlighted in the
// theme's colours, and code blocks and quotes can be copied.
import type { Element, ElementContent } from 'hast';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import type { Html, Nodes, PhrasingContent, Root } from 'mdast';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { isWebLink } from '../shared/links';
import { useApi } from './api';

/** Nodes whose children are blocks, where raw HTML stands as a block of its own. */
const BLOCK_CONTAINERS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/** Raw HTML's text, its lines kept. */
function htmlLines({ value }: Html): PhrasingContent[] {
  return value.split('\n').flatMap((line, i): PhrasingContent[] => (i === 0 ? [{ type: 'text', value: line }] : [{ type: 'break' }, { type: 'text', value: line }]));
}

/** Turns raw HTML into plain text: a paragraph of it when it is a block. */
function remarkHtmlAsText() {
  const visit = (node: Nodes) => {
    if (!('children' in node)) return;
    const children: Nodes[] = node.children.map((child) => {
      if (child.type !== 'html') return child;
      return BLOCK_CONTAINERS.has(node.type) ? { type: 'paragraph', children: htmlLines(child) } : { type: 'text', value: child.value };
    });
    (node as { children: Nodes[] }).children = children;
    children.forEach(visit);
  };
  return (tree: Root) => visit(tree);
}

/** The text of a node and everything in it, highlighting spans and all. */
function textOf(node: ElementContent): string {
  return node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : '';
}

/** The language a fenced block was given, from its code's `language-*` class. */
function languageOf(code: Element | undefined): string | undefined {
  const classes = code?.properties.className;
  const language = Array.isArray(classes) ? classes.find((c): c is string => typeof c === 'string' && c.startsWith('language-')) : undefined;
  return language?.slice('language-'.length);
}

/** A button that puts `text` on the clipboard, and says how that went for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [outcome, setOutcome] = useState<'copied' | 'failed'>();
  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(undefined), 1500);
    return () => clearTimeout(timer);
  }, [outcome]);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setOutcome('copied'),
      () => setOutcome('failed'),
    );
  };
  const said = outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Copy failed' : undefined;
  return (
    <button type="button" className={`copy-btn${outcome === 'failed' ? ' failed' : ''}`} aria-label={said ?? label} title={label} onClick={copy}>
      {outcome === 'copied' ? <Check className="sm" /> : outcome === 'failed' ? <TriangleAlert className="sm" /> : <Copy className="sm" />}
      {said ?? 'Copy'}
    </button>
  );
}

function CodeBlock({ node, children }: { node?: Element; children?: ReactNode }) {
  const code = node?.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
  const language = languageOf(code);
  // The fence's closing newline is no part of the code.
  const text = code ? textOf(code).replace(/\n$/, '') : '';
  return (
    <figure className="code-block">
      <figcaption>
        <span className="grow tech">{language}</span>
        <CopyButton text={text} label="Copy code" />
      </figcaption>
      <pre>{children}</pre>
    </figure>
  );
}

/** The message being rendered, for the parts that copy from its source. */
const MessageSource = createContext('');

/** A quote's Markdown, as written in `source`, without its quote markers. */
function quoteText(source: string, node: Element | undefined): string {
  const { start, end } = node?.position ?? {};
  if (start?.offset === undefined || end?.offset === undefined) return node ? textOf(node).trim() : '';
  return source
    .slice(start.offset, end.offset)
    .split('\n')
    .map((line) => line.replace(/^\s*> ?/, ''))
    .join('\n')
    .trim();
}

function Quote({ node, children }: { node?: Element; children?: ReactNode }) {
  const source = useContext(MessageSource);
  return (
    <div className="quote-block">
      <blockquote>{children}</blockquote>
      <CopyButton text={quoteText(source, node)} label="Copy quote" />
    </div>
  );
}

/**
 * A link: a web link opens in the system browser, as the Loom window never
 * navigates; a jump within the message (a footnote) is left to the page; any
 * other, which Loom won't open, stays plain text with its target on hover.
 */
function Link({ href, children, ...rest }: { href?: string; children?: ReactNode; id?: string }) {
  const api = useApi();
  if (href?.startsWith('#'))
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  if (!href || !isWebLink(href)) return <span title={href}>{children}</span>;
  return (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        api.invoke('links.open', { url: href }).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}

// Fixed, so a streaming reply updates its blocks in place instead of remounting them.
const COMPONENTS: Components = {
  pre: ({ node, children }) => <CodeBlock node={node}>{children}</CodeBlock>,
  blockquote: ({ node, children }) => <Quote node={node}>{children}</Quote>,
  a: ({ node: _, ...props }) => <Link {...props} />,
};

const REMARK = [remarkGfm, remarkHtmlAsText];
// The user types line breaks as they mean them, as in a chat; agents write Markdown.
const USER_REMARK = [...REMARK, remarkBreaks];
const REHYPE = [rehypeHighlight];

export function Markdown({ text, breaks = false }: { text: string; breaks?: boolean }) {
  return (
    <div className="md">
      <MessageSource value={text}>
        <ReactMarkdown remarkPlugins={breaks ? USER_REMARK : REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      </MessageSource>
    </div>
  );
}
