import React, { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import Prism from 'prismjs';

// Import Prism core styles
import 'prismjs/themes/prism.css';

// Import language support
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-json';

interface MarkdownViewerProps {
  content: string;
  className?: string;
}

const MarkdownViewer: React.FC<MarkdownViewerProps> = ({ content, className = '' }) => {
  // Initialize Prism when component mounts or content changes
  useEffect(() => {
    Prism.highlightAll();
  }, [content]);

  return (
    <div className={`markdown-viewer prose prose-sm max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{
          code: ({ node, inline, className, children, ...props }: any) => {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';
            
            return !inline && language ? (
              <div className="relative group">
                <pre className={`!mt-0 !mb-4`}>
                  <code className={`language-${language}`} {...props}>
                    {String(children).replace(/\n$/, '')}
                  </code>
                </pre>
                <button
                  onClick={() => navigator.clipboard.writeText(String(children))}
                  className="absolute top-2 right-2 p-1.5 rounded opacity-0 group-hover:opacity-100 
                           bg-gray-700 text-white text-xs hover:bg-gray-600 transition-opacity"
                >
                  Copy
                </button>
              </div>
            ) : (
              <code className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-800" {...props}>
                {children}
              </code>
            );
          },
          // Custom styling for other markdown elements
          h1: ({ children }) => <h1 className="text-2xl font-bold my-4">{children}</h1>,
          h2: ({ children }) => <h2 className="text-xl font-bold my-3">{children}</h2>,
          h3: ({ children }) => <h3 className="text-lg font-bold my-2">{children}</h3>,
          p: ({ children }) => <p className="my-2 text-gray-700">{children}</p>,
          ul: ({ children }) => <ul className="list-disc list-inside my-2">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside my-2">{children}</ol>,
          li: ({ children }) => <li className="my-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-gray-200 pl-4 my-2 italic">
              {children}
            </blockquote>
          ),
          a: ({ children, href }) => (
            <a 
              href={href} 
              className="text-red-600 hover:text-red-700 underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-4">
              <table className="min-w-full divide-y divide-gray-200">
                {children}
              </table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownViewer;