// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import { BookmarkProvider, useBookmarkContext } from './BookmarkContext'

const showToast = vi.fn()
const reorderBookmarks = vi.fn()
const createBookmark = vi.fn()

vi.mock('./ToastContext', () => ({
  useToastContext: () => ({ showToast }),
}))
vi.mock('../i18n', () => ({
  useT: () => (key: string) => key,
}))
vi.mock('../lib/dev-log', () => ({ devLog: vi.fn(), devWarn: vi.fn() }))
vi.mock('../services/api', () => ({
  getBookmarks: vi.fn().mockResolvedValue({ bookmarks: [] }),
  getPlaces: vi.fn().mockResolvedValue([]),
  getTags: vi.fn().mockResolvedValue([]),
  backfillBookmarkFlags: vi.fn().mockResolvedValue({ filled: 0 }),
  reorderBookmarks: (ids: string[]) => reorderBookmarks(ids),
  createBookmark: (bm: unknown) => createBookmark(bm),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BookmarkProvider reorder', () => {
  it('toasts when saving the new bookmark order fails', async () => {
    reorderBookmarks.mockRejectedValueOnce(new Error('500'))
    let reorder: ((ids: string[]) => Promise<void>) | null = null
    function Consumer() {
      reorder = useBookmarkContext().handleBookmarksReorder
      return null
    }
    render(<BookmarkProvider><Consumer /></BookmarkProvider>)
    await waitFor(() => expect(reorder).not.toBeNull())

    await act(async () => { await reorder!(['b', 'a']) })

    expect(reorderBookmarks).toHaveBeenCalledWith(['b', 'a'])
    expect(showToast).toHaveBeenCalledWith('toast.reorder_failed')
  })
})

describe('BookmarkProvider add-bookmark dialog', () => {
  type Ctx = ReturnType<typeof useBookmarkContext>
  function renderCtx() {
    const ref: { current: Ctx | null } = { current: null }
    function Consumer() {
      ref.current = useBookmarkContext()
      return null
    }
    render(<BookmarkProvider><Consumer /></BookmarkProvider>)
    return ref
  }
  const payload = { name: 'Cafe', lat: 25, lng: 121, place_id: 'default', tags: ['t1'], note: 'n' }

  it('keeps the dialog open and toasts when the save fails', async () => {
    createBookmark.mockRejectedValueOnce(new Error('disk full'))
    const ctx = renderCtx()
    await waitFor(() => expect(ctx.current).not.toBeNull())
    act(() => { ctx.current!.handleAddBookmark(25, 121) })

    await act(async () => { await ctx.current!.submitAddBookmark(payload) })

    expect(createBookmark).toHaveBeenCalledWith(payload)
    expect(ctx.current!.addBmDialog).toEqual({ lat: 25, lng: 121 })
    expect(showToast).toHaveBeenCalledWith('toast.save_failed')
  })

  it('closes the dialog after a successful save', async () => {
    createBookmark.mockResolvedValueOnce({ id: 'x', ...payload })
    const ctx = renderCtx()
    await waitFor(() => expect(ctx.current).not.toBeNull())
    act(() => { ctx.current!.handleAddBookmark(25, 121) })

    await act(async () => { await ctx.current!.submitAddBookmark(payload) })

    expect(ctx.current!.addBmDialog).toBeNull()
  })
})
