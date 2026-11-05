// A chat message's text, rendered as GitHub-flavoured Markdown. Raw HTML in it
// is shown as the text it is, never rendered; code blocks are highlighted in the
// theme's colours, and code blocks and quotes can be copied.
import { Check, Copy } from 'lucide-react';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { useApi } from './api';

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

/** Nodes whose children are blocks, where raw HTML stands as a block of its own. */
const FLOW = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/** Turns raw HTML into plain text: a paragraph of it when it is a block. */
function remarkHtmlAsText() {
  const visit = (node: MdastNode) => {
    node.children = node.children?.map((child) => {
      if (child.type !== 'html') return child;
      const text = { type: 'text', value: child.value };
      return FLOW.has(node.type) ? { type: 'paragraph', children: [text] } : text;
    });
    node.children?.forEach(visit);
  };
  return visit;
}

interface HastNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

/** The text of a node and everything in it, highlighting spans and all. */
function textOf(node: HastNode): string {
  return node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join('');
}

/** The language a fenced block was given, from its code's `language-*` class. */
function languageOf(code: HastNode | undefined): string | undefined {
  const classes = code?.properties?.className;
  const language = Array.isArray(classes) ? classes.find((c): c is string => typeof c === 'string' && c.startsWith('language-')) : undefined;
  return language?.slice('language-'.length);
}

/** A button that puts `text` on the clipboard, and says so for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => {},
    );
  };
  return (
    <button type="button" className="copy-btn" aria-label={copied ? 'Copied' : label} title={label} onClick={copy}>
      {copied ? <Check className="sm" /> : <Copy className="sm" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const code = node?.children?.find((child) => child.tagName === 'code');
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

/** A quote's Markdown, as written in `source`, without its quote markers. */
function quoteText(source: string, node: HastNode | undefined): string {
  const { start, end } = node?.position ?? {};
  if (start?.offset === undefined || end?.offset === undefined) return node ? textOf(node).trim() : '';
  return source
    .slice(start.offset, end.offset)
    .split('\n')
    .map((line) => line.replace(/^\s*> ?/, ''))
    .join('\n')
    .trim();
}

/** The message being rendered, for the parts that need its source. */
const Source = createContext('');

function Quote({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const source = useContext(Source);
  return (
    <div className="quote-block">
      <blockquote>{children}</blockquote>
      <CopyButton text={quoteText(source, node)} label="Copy quote" />
    </div>
  );
}

/** A link, opened in the system browser: the Loom window never navigates. */
function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const api = useApi();
  return (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) api.invoke('links.open', { url: href }).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}

// Fixed, so a streaming reply updates its blocks in place instead of remounting them.
const COMPONENTS: Components = {
  pre: ({ node, children }) => <CodeBlock node={node as HastNode | undefined}>{children}</CodeBlock>,
  blockquote: ({ node, children }) => <Quote node={node as HastNode | undefined}>{children}</Quote>,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
};

const REMARK = [remarkGfm, remarkHtmlAsText];
// The user types line breaks as they mean them, as in a chat; agents write Markdown.
const USER_REMARK = [...REMARK, remarkBreaks];
const REHYPE = [rehypeHighlight];

export function Markdown({ text, breaks = false }: { text: string; breaks?: boolean }) {
  return (
    <div className="md">
      <Source value={text}>
        <ReactMarkdown remarkPlugins={breaks ? USER_REMARK : REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      </Source>
    </div>
  );
}
