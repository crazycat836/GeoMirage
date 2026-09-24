// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import { BookmarkProvider, useBookmarkContext } from './BookmarkContext'

const showToast = vi.fn()
const reorderBookmarks = vi.fn()

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
