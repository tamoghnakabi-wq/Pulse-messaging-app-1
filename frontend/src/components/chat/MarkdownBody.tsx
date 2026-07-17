import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  content: string;
}

/**
 * Isolated markdown renderer so react-markdown / remark-gfm stay out of the
 * main chat chunk until a message actually needs formatting or links.
 */
export function MarkdownBody({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      // No rehype-raw — never render raw HTML from user content
      skipHtml
      components={{
        a: ({ href, children }) => {
          const safe =
            href &&
            (href.startsWith('https://') ||
              href.startsWith('http://') ||
              href.startsWith('mailto:')) &&
            !href.toLowerCase().startsWith('javascript:') &&
            !href.toLowerCase().startsWith('data:');
          if (!safe) {
            return <span>{children}</span>;
          }
          return (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          );
        },
        // Block images / media / scripts in markdown (attachments use separate renderer)
        img: () => null,
        script: () => null,
        iframe: () => null,
        object: () => null,
        embed: () => null,
        form: () => null,
        input: () => null,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
