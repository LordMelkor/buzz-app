import { defaultTreeAdapter, Parser } from "parse5";
import type { DefaultTreeAdapterTypes as P, TreeAdapter } from "parse5";
import { MAX_RENDER_DEPTH, required } from "./markdown-limits";

/** Shared with pages: stop while the real HTML parser's stack is shallow,
 * before its per-token ancestor scans can become quadratic. */
export class BoundedHtmlParser extends Parser<P.DefaultTreeAdapterMap> {
  override onItemPush(node: P.ParentNode, tag: number, top: boolean): void {
    if (this.openElements.stackTop >= MAX_RENDER_DEPTH)
      throw new RangeError("HTML nesting limit");
    super.onItemPush(node, tag, top);
  }
}

/** Admission only, using parse5's actual insertion modes/foreign-content and
 * active-formatting rules. Discard text/comment contents and prune completed
 * siblings; retain only the parser's live element ancestry, not a second full
 * DOM. The later raw parser still owns the rendered, source-positioned tree. */
export function htmlWithinDepth(source: string): boolean {
  let parser: BoundedHtmlParser | undefined;
  const open = (node: P.Node): boolean => {
    if (!parser) return false;
    for (let at = 0; at <= parser.openElements.stackTop; at++)
      if (parser.openElements.items[at] === node) return true;
    return false;
  };
  const prune = (parent: P.ParentNode, keep?: P.ChildNode) => {
    for (let at = parent.childNodes.length - 1; at >= 0; at--) {
      const child = required(parent.childNodes[at]);
      if (child !== keep && !open(child)) defaultTreeAdapter.detachNode(child);
    }
  };
  const admission: TreeAdapter<P.DefaultTreeAdapterMap> = {
    ...defaultTreeAdapter,
    appendChild(parent, child) {
      prune(parent);
      defaultTreeAdapter.appendChild(parent, child);
    },
    insertBefore(parent, child, before) {
      prune(parent, before);
      defaultTreeAdapter.insertBefore(parent, child, before);
    },
    insertText() {
      /* Text affects parser state, but admission retains none. */
    },
    insertTextBefore() {
      /* Foster-parented text also retains no content. */
    },
    createCommentNode() {
      return defaultTreeAdapter.createCommentNode("");
    },
    onItemPop(node) {
      if ("parentNode" in node) defaultTreeAdapter.detachNode(node);
    },
  };
  try {
    parser = BoundedHtmlParser.getFragmentParser(null, {
      scriptingEnabled: false,
      treeAdapter: admission,
    });
    parser.tokenizer.write(source, true);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}
