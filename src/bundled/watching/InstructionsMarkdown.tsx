import Markdown, { type Components } from "react-markdown";

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => alt ?? "",
};

export function InstructionsMarkdown({ text }: { text: string }) {
  return (
    <div className="attention-markdown text-body-sm text-secondary">
      <Markdown
        components={components}
        urlTransform={(url) =>
          /^(https?:|mailto:|buzz:|nostr:|#)/i.test(url) ? url : ""
        }
      >
        {text}
      </Markdown>
    </div>
  );
}
