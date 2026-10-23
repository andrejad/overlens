import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/react'
import { DescriptionEditor, EDITOR_FONTS } from './DescriptionEditor'

// jsdom has no layout: ProseMirror's scrollIntoView asks for client rects.
Element.prototype.getClientRects ??= () => [] as unknown as DOMRectList
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect ??= () => new DOMRect()

// jsdom has no real focus, so the editor's blur event is emitted directly (what leaving the editor does).
const blur = (ed: Editor) => act(() => void ed.emit('blur', { editor: ed, event: new FocusEvent('blur'), transaction: ed.state.tr }))

async function setup(html = '<p>Hello</p>') {
  const onCommit = vi.fn()
  const { container } = render(<DescriptionEditor html={html} onCommit={onCommit} />)
  await waitFor(() => expect(container.querySelector('.editor .tb')).toBeTruthy())
  const dom = container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }
  const select = (from: number, to: number) => act(() => void dom.editor.chain().focus().setTextSelection({ from, to }).run())
  const press = (label: string) => act(() => void fireEvent.mouseDown(screen.getByLabelText(label)))
  return { container, onCommit, editor: dom.editor, select, press }
}

describe('REQ_FE_027 description editor', () => {
  it('REQ_FE_027 an invalid description gets the red border', async () => {
    const { container } = render(<DescriptionEditor html="" onCommit={vi.fn()} invalid />)
    await waitFor(() => expect(container.querySelector('.editor.bad')).toBeTruthy())
  })
})

describe('REQ_FE_124 description editor toolbar', () => {
  it('REQ_FE_124 has the font and size choices and every button, in separated groups', async () => {
    const { container } = await setup()
    const tb = container.querySelector('.tb') as HTMLElement
    expect(Array.from(screen.getByLabelText('Font').querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Default', 'Serif', 'Monospace', 'Arial', 'Verdana', 'Times New Roman',
    ])
    expect(Array.from(screen.getByLabelText('Size').querySelectorAll('option')).map((o) => o.textContent)).toEqual(['12', '14', '16', '18', '20', '24'])
    expect(screen.getByLabelText('Size')).toHaveValue('14px')
    const labels = Array.from(tb.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(['Bold', 'Italic', 'Underline', 'Strikethrough', 'Heading', 'Bullet list', 'Numbered list', 'Clear formatting'])
    expect(tb.querySelectorAll('.sp')).toHaveLength(4)
    expect(tb.querySelector('svg')?.getAttribute('width')).toBe('18')
  })

  it('REQ_FE_124 the button for formatting under the cursor is shown active', async () => {
    const { select, press } = await setup()
    expect(screen.getByLabelText('Bold').className).not.toMatch(/\bactive\b/)
    select(1, 6)
    press('Bold')
    await waitFor(() => expect(screen.getByLabelText('Bold').className).toMatch(/\bactive\b/))
    expect(screen.getByLabelText('Italic').className).not.toMatch(/\bactive\b/)
  })

  it('REQ_FE_124 choosing a font and a size saves them at once in the committed HTML, and the selects show them under the cursor', async () => {
    const { select, onCommit } = await setup()
    select(1, 6)
    fireEvent.change(screen.getByLabelText('Font'), { target: { value: EDITOR_FONTS[5].value } })
    fireEvent.change(screen.getByLabelText('Size'), { target: { value: '20px' } })
    const html = onCommit.mock.lastCall![0] as string
    expect(html).toContain('font-family: &quot;Times New Roman&quot;, serif')
    expect(html).toContain('font-size: 20px')
    select(2, 3)
    await waitFor(() => expect(screen.getByLabelText('Font')).toHaveValue('"Times New Roman", serif'))
    expect(screen.getByLabelText('Size')).toHaveValue('20px')
  })

  it('REQ_FE_124 Default font and 14 px remove the font and size again', async () => {
    const { select, onCommit, editor } = await setup('<p><span style="font-family: Arial, sans-serif; font-size: 24px">Hello</span></p>')
    select(1, 6)
    fireEvent.change(screen.getByLabelText('Font'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Size'), { target: { value: '14px' } })
    blur(editor)
    expect(onCommit.mock.lastCall![0]).not.toMatch(/font-(family|size)/)
  })

  it('REQ_FE_124 Clear formatting removes marks, fonts and the heading', async () => {
    const { select, press, onCommit, editor } = await setup('<h3><strong><span style="font-size: 24px">Hello</span></strong></h3><p>End</p>')
    select(1, 6)
    press('Clear formatting')
    blur(editor)
    expect(onCommit.mock.lastCall![0]).toBe('<p>Hello</p><p>End</p>')
  })
})

describe('REQ_API_030 the editor only produces what the server keeps', () => {
  // Types text the way the browser does: each character goes through the editor's input rules first.
  const type = (ed: Editor, text: string) =>
    act(() => {
      for (const ch of text) {
        const { from, to } = ed.state.selection
        if (!ed.view.someProp('handleTextInput', (f) => f(ed.view, from, to, ch, () => ed.state.tr.insertText(ch, from, to)))) ed.view.dispatch(ed.state.tr.insertText(ch, from, to))
      }
    })

  it('REQ_API_030 typing "> ", "```" or "---" makes no blockquote, code block or rule ("- " still starts a list); there is no inline code; a link keeps only an http(s) address', async () => {
    const { editor, select } = await setup('<p></p>')
    select(1, 1)
    type(editor, '> quote')
    expect(editor.getHTML()).toBe('<p>&gt; quote</p>')
    act(() => void editor.commands.setContent('<p></p>'))
    select(1, 1)
    type(editor, '```')
    type(editor, ' ')
    type(editor, '---')
    expect(editor.getHTML()).not.toMatch(/<(pre|code|hr|blockquote)/)
    act(() => void editor.commands.setContent('<p></p>'))
    select(1, 1)
    type(editor, '- item')
    expect(editor.getHTML()).toContain('<ul>') // the typing above does reach the input rules
    expect(editor.schema.marks.code).toBeUndefined()
    act(() => void editor.commands.setContent('<p><a href="https://example.com">web</a> <a href="mailto:a@example.com">mail</a> <a href="javascript:alert(1)">js</a></p>'))
    const hrefs = Array.from(new DOMParser().parseFromString(editor.getHTML(), 'text/html').querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs.filter(Boolean)).toEqual(['https://example.com'])
  })
})
