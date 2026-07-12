import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
  rectangularSelection,
} from "@codemirror/view";
import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

const readOnlyCompartment = new Compartment();

const orbitEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--code-editor-fg)",
    backgroundColor: "var(--code-editor-bg)",
    fontSize: "13px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: "22px",
  },
  ".cm-content": { padding: "12px 0", caretColor: "var(--code-editor-cursor)" },
  ".cm-line": { padding: "0 16px" },
  ".cm-gutters": {
    color: "var(--code-editor-faint)",
    backgroundColor: "var(--code-editor-bg)",
    borderRight: "1px solid var(--code-editor-border)",
  },
  ".cm-activeLineGutter": {
    color: "var(--code-editor-muted)",
    backgroundColor: "var(--code-editor-line-highlight)",
  },
  ".cm-activeLine": { backgroundColor: "var(--code-editor-line-highlight)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--code-editor-selection) !important",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--code-editor-cursor)",
  },
  ".cm-panels": {
    color: "var(--code-editor-fg)",
    backgroundColor: "var(--code-editor-widget-bg)",
  },
  ".cm-tooltip": {
    color: "var(--code-editor-fg)",
    backgroundColor: "var(--code-editor-widget-bg)",
    borderColor: "var(--code-editor-border)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--code-editor-line-highlight)",
    color: "var(--code-editor-fg)",
  },
  ".cm-placeholder": { color: "var(--code-editor-placeholder)" },
});

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  className?: string;
  style?: CSSProperties;
  minHeight?: number | string;
  placeholder?: string;
  ariaLabel?: string;
  toolbar?: ReactNode;
  footer?: ReactNode;
}

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  className = "",
  style,
  minHeight = 360,
  placeholder,
  ariaLabel,
  toolbar,
  footer,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  onChangeRef.current = onChange;
  valueRef.current = value;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const editor = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          crosshairCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          javascript(),
          placeholderExtension(placeholder ?? ""),
          keymap.of([
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
          ]),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel ?? "Code editor",
            autocapitalize: "off",
            autocomplete: "off",
            autocorrect: "off",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const nextValue = update.state.doc.toString();
            valueRef.current = nextValue;
            onChangeRef.current(nextValue);
          }),
          readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
          orbitEditorTheme,
        ],
      }),
    });
    editorRef.current = editor;

    return () => {
      editor.destroy();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
    });
  }, [value]);

  useEffect(() => {
    editorRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  const resolvedMinHeight =
    typeof minHeight === "number" ? `${minHeight}px` : minHeight;

  return (
    <div
      className={`code-editor-shell ${className}`.trim()}
      style={
        {
          ...style,
          "--code-editor-min-height": resolvedMinHeight,
        } as CSSProperties
      }
    >
      {toolbar ? <div className="code-editor-toolbar">{toolbar}</div> : null}
      <div className="code-editor-body">
        <div className="code-editor-codemirror" ref={hostRef} />
      </div>
      {footer ? <div className="code-editor-footer">{footer}</div> : null}
    </div>
  );
}
