import { useEditor, useEditorState, EditorContent } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { Bold, Heading3, Italic, List, ListOrdered, RemoveFormatting, Strikethrough, Underline } from 'lucide-react'

// REQ_FE_124: the fonts and sizes the toolbar offers. `value` is exactly what is written into the saved HTML's
// style attribute; the server whitelists the same strings (keep both in step). Default / 14 px mean "unset".
export const EDITOR_FONTS = [
  { label: 'Default', value: '' },
  { label: 'Serif', value: 'Georgia, serif' },
  { label: 'Monospace', value: 'ui-monospace, monospace' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Verdana', value: 'Verdana, sans-serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
] as const
export const EDITOR_SIZES = ['12px', '14px', '16px', '18px', '20px', '24px'] as const
export const DEFAULT_EDITOR_SIZE = '14px'

// REQ_API_030: the editor can only produce what the server keeps. StarterKit's blockquote, inline code, code block and
// horizontal rule (all reachable by typing, e.g. "> ") would be stripped on save, so they are left out; a link keeps
// only an http(s) address.
const EDITOR_STARTER_KIT = StarterKit.configure({
  blockquote: false,
  code: false,
  codeBlock: false,
  horizontalRule: false,
  link: { isAllowedUri: (url) => /^https?:\/\//i.test(url) },
})

// Toolbar buttons keep the editor focused (mousedown is cancelled) and run one command.
function Tool({ label, active, onRun, children }: { label: string; active?: boolean; onRun: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`btn ghost${active ? ' active' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault()
        onRun()
      }}
    >
      {children}
    </button>
  )
}

function Toolbar({ editor, onCommit }: { editor: Editor; onCommit: (html: string) => void }) {
  // Re-render when the selection or content changes so the active states and selects follow the cursor.
  const s = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      bold: ed.isActive('bold'),
      italic: ed.isActive('italic'),
      underline: ed.isActive('underline'),
      strike: ed.isActive('strike'),
      heading: ed.isActive('heading', { level: 3 }),
      bullet: ed.isActive('bulletList'),
      ordered: ed.isActive('orderedList'),
      font: (ed.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
      size: (ed.getAttributes('textStyle').fontSize as string | undefined) ?? DEFAULT_EDITOR_SIZE,
    }),
  })
  const chain = () => editor.chain().focus()
  // The selects keep the keyboard focus (arrow keys step through the options): they format the editor's
  // remembered selection without refocusing it and save at once, since no later blur of the editor follows.
  const applyStyle = (run: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => {
    run(editor.chain()).run()
    onCommit(editor.getHTML())
  }
  return (
    <div className="tb">
      <select
        aria-label="Font"
        className="tb-select"
        value={EDITOR_FONTS.some((f) => f.value === s.font) ? s.font : ''}
        onChange={(e) => {
          const v = e.target.value
          applyStyle((c) => (v ? c.setFontFamily(v) : c.unsetFontFamily()))
        }}
      >
        {EDITOR_FONTS.map((f) => (
          <option key={f.label} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Size"
        className="tb-select"
        value={(EDITOR_SIZES as readonly string[]).includes(s.size) ? s.size : DEFAULT_EDITOR_SIZE}
        onChange={(e) => {
          const v = e.target.value
          applyStyle((c) => (v === DEFAULT_EDITOR_SIZE ? c.unsetFontSize() : c.setFontSize(v)))
        }}
      >
        {EDITOR_SIZES.map((z) => (
          <option key={z} value={z}>
            {z.replace('px', '')}
          </option>
        ))}
      </select>
      <span className="sp" />
      <Tool label="Bold" active={s.bold} onRun={() => chain().toggleBold().run()}>
        <Bold size={18} />
      </Tool>
      <Tool label="Italic" active={s.italic} onRun={() => chain().toggleItalic().run()}>
        <Italic size={18} />
      </Tool>
      <Tool label="Underline" active={s.underline} onRun={() => chain().toggleUnderline().run()}>
        <Underline size={18} />
      </Tool>
      <Tool label="Strikethrough" active={s.strike} onRun={() => chain().toggleStrike().run()}>
        <Strikethrough size={18} />
      </Tool>
      <span className="sp" />
      <Tool label="Heading" active={s.heading} onRun={() => chain().toggleHeading({ level: 3 }).run()}>
        <Heading3 size={18} />
      </Tool>
      <span className="sp" />
      <Tool label="Bullet list" active={s.bullet} onRun={() => chain().toggleBulletList().run()}>
        <List size={18} />
      </Tool>
      <Tool label="Numbered list" active={s.ordered} onRun={() => chain().toggleOrderedList().run()}>
        <ListOrdered size={18} />
      </Tool>
      <span className="sp" />
      <Tool label="Clear formatting" onRun={() => chain().clearNodes().unsetAllMarks().run()}>
        <RemoveFormatting size={18} />
      </Tool>
    </div>
  )
}

// Open question E / REQ_FE_025: the same TipTap component is used by the side panel's quick-edit
// form and the full edit modal, so the two structurally cannot drift apart. Autosaves on blur, like
// every other text field (REQ_FE_026) — no Save button here either. Using a toolbar select blurs the
// editor (one commit of the old HTML, which callers skip as unchanged); the select's change then saves the new one.
export function DescriptionEditor({
  html,
  onCommit,
  editable = true,
  invalid = false,
}: {
  html: string
  onCommit: (html: string) => void
  editable?: boolean
  // REQ_FE_027: red border when the last save of this field was rejected.
  invalid?: boolean
}) {
  const editor = useEditor({
    extensions: [EDITOR_STARTER_KIT, TextStyle, FontFamily, FontSize],
    content: html,
    editable,
    onBlur: ({ editor }) => onCommit(editor.getHTML()),
  })

  if (!editor) return null

  return (
    <div className={`editor${invalid ? ' bad' : ''}`}>
      {editable && <Toolbar editor={editor} onCommit={onCommit} />}
      <EditorContent className="content rich" editor={editor} />
    </div>
  )
}
