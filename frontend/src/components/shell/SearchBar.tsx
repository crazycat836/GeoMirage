import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Search, MapPin } from 'lucide-react'
import { searchAddress } from '../../services/api'
import { useT, useI18n, type Lang } from '../../i18n'
import { useOutsideClick } from '../../hooks/useOutsideClick'
import { formatCoord, coordKey } from '../../lib/format'

// Mirror the reverse-geocode hook's language chain so result names come back
// in the UI language. Traditional-Chinese lists `zh-Hant`/`zh-TW` ahead of
// bare `zh` so providers don't fall back to Simplified labels. Typed against
// the `Lang` union (not bare `string`) so a non-locale value can't slip in.
function searchLang(lang: Lang): string {
  return lang === 'zh' ? 'zh-Hant,zh-TW,zh,en' : 'en'
}

const COORD_RE = /^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/

interface SearchResult {
  name: string
  lat: number
  lng: number
  address?: string
}

interface SearchBarProps {
  onTeleport: (lat: number, lng: number) => void
  deviceConnected: boolean
}

export default function SearchBar({ onTeleport, deviceConnected }: SearchBarProps) {
  const t = useT()
  const { lang } = useI18n()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  // Distinct from "no results": true only when searchAddress actually
  // rejects (transport / backend-app failure). The geocoder-unavailable
  // case resolves to [] per the backend contract, so an empty array is NOT
  // an error — collapsing the two would report outages as "no results".
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  // Highlighted option index for keyboard navigation (-1 = none). Combobox
  // pattern: ArrowDown/Up move it, Enter activates it.
  const [activeIndex, setActiveIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bumped by every search and by anything that makes an in-flight search
  // obsolete (new short query, selection). A response only lands if its
  // sequence number is still the latest, so a slow earlier request can't
  // overwrite newer results or reopen the dropdown after a selection.
  const searchSeqRef = useRef(0)

  const cancelPendingSearch = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    searchSeqRef.current++
    setLoading(false)
  }, [])

  // Parse coordinate from input
  const coordMatch = COORD_RE.exec(query.trim())
  const parsedCoord = coordMatch ? {
    lat: parseFloat(coordMatch[1]),
    lng: parseFloat(coordMatch[2]),
  } : null
  const validCoord = parsedCoord &&
    parsedCoord.lat >= -90 && parsedCoord.lat <= 90 &&
    parsedCoord.lng >= -180 && parsedCoord.lng <= 180
    ? parsedCoord : null

  // Address search with debounce
  const doSearch = useCallback(async (q: string) => {
    const seq = ++searchSeqRef.current
    if (q.trim().length < 2 || COORD_RE.test(q.trim())) {
      setResults([])
      setError(false)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(false)
    try {
      const raw = await searchAddress(q, searchLang(lang))
      if (seq !== searchSeqRef.current) return
      setResults((Array.isArray(raw) ? raw : []).map((r) => ({
        name: r.display_name,
        lat: r.lat,
        lng: r.lng,
      })))
      setOpen(true)
    } catch {
      if (seq !== searchSeqRef.current) return
      // Real failure (transport / backend down / malformed envelope) — show
      // an error rather than the misleading "no results" empty state.
      setResults([])
      setError(true)
      setOpen(true)
    } finally {
      if (seq === searchSeqRef.current) setLoading(false)
    }
  }, [lang])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value
    setQuery(q)
    if (q.trim().length < 2) {
      // Nothing to search: drop the pending debounce and any in-flight
      // response instead of waiting for them to land.
      cancelPendingSearch()
      setResults([])
      setError(false)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(q), 300)
  }, [doSearch, cancelPendingSearch])

  const handleSelect = useCallback((lat: number, lng: number) => {
    // Result buttons are disabled without a device, but keyboard Enter
    // reaches here directly — gate it the same way so the connection
    // requirement can't be bypassed.
    if (!deviceConnected) return
    onTeleport(lat, lng)
    cancelPendingSearch()
    setQuery('')
    setResults([])
    setOpen(false)
    inputRef.current?.blur()
  }, [onTeleport, deviceConnected, cancelPendingSearch])

  const handleSubmit = useCallback(() => {
    if (validCoord) {
      handleSelect(validCoord.lat, validCoord.lng)
    }
  }, [validCoord, handleSelect])

  // ⌘K to focus the search input.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Close dropdown on outside click. Standardised on `pointerdown` via the
  // shared hook so dismissal also fires for touch and pen input.
  const closeDropdown = useCallback(() => setOpen(false), [])
  useOutsideClick(containerRef, closeDropdown, open)

  // Cleanup debounce
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  // Typing resets the keyboard highlight to "none".
  useEffect(() => { setActiveIndex(-1) }, [query])

  const showDropdown = open || (focused && (validCoord != null || loading || error))

  // Flat, selectable option list (coord match first, then address results) —
  // the model the combobox keyboard nav + aria-activedescendant index into.
  const options: { id: string; lat: number; lng: number }[] = []
  if (validCoord) options.push({ id: 'search-opt-coord', lat: validCoord.lat, lng: validCoord.lng })
  results.forEach((r, i) => options.push({ id: `search-opt-${i}`, lat: r.lat, lng: r.lng }))
  const resultIndexOffset = validCoord ? 1 : 0
  const activeOptionId = activeIndex >= 0 && activeIndex < options.length
    ? options[activeIndex].id
    : undefined

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    const count = options.length
    if (e.key === 'ArrowDown') {
      if (count === 0) return
      e.preventDefault(); setOpen(true); setActiveIndex((i) => (i + 1) % count)
    } else if (e.key === 'ArrowUp') {
      if (count === 0) return
      e.preventDefault(); setOpen(true); setActiveIndex((i) => (i - 1 + count) % count)
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < count) {
        const o = options[activeIndex]
        handleSelect(o.lat, o.lng)
      } else {
        handleSubmit()
      }
    } else if (e.key === 'Escape') {
      setOpen(false); setActiveIndex(-1); inputRef.current?.blur()
    }
  }

  return (
    <div ref={containerRef} data-fc="topbar.search" className="relative">
      {/* Input */}
      <div className="glass-pill flex items-center gap-2.5 px-4 h-11 w-[380px]">
        <Search className="w-[14px] h-[14px] text-[var(--color-text-3)] shrink-0" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="search-listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          aria-label={t('search.unified_placeholder')}
          value={query}
          onChange={handleInput}
          onFocus={() => { setFocused(true); if (results.length > 0) setOpen(true) }}
          onBlur={() => setFocused(false)}
          onKeyDown={handleKeyDown}
          placeholder={t('search.unified_placeholder')}
          className="flex-1 bg-transparent border-none outline-none text-[var(--color-text-1)] text-[13px] placeholder:text-[var(--color-text-3)]"
        />
        {!focused && (
          <kbd className="text-[10px] font-mono text-[var(--color-text-3)] bg-white/[0.05] px-1.5 py-0.5 rounded border border-[var(--color-border)]">
            ⌘K
          </kbd>
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div
          id="search-listbox"
          role="listbox"
          aria-label={t('search.results_aria')}
          className="absolute top-full left-0 mt-2 w-full surface-popup rounded-xl overflow-hidden anim-fade-slide-up"
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* Coordinate match */}
          {validCoord && (
            <button
              id="search-opt-coord"
              role="option"
              aria-selected={activeIndex === 0}
              onMouseEnter={() => setActiveIndex(0)}
              onClick={() => handleSelect(validCoord.lat, validCoord.lng)}
              disabled={!deviceConnected}
              title={!deviceConnected ? t('action.disabled_no_device') : undefined}
              className={[
                'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                activeIndex === 0 ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]',
              ].join(' ')}
            >
              <MapPin className="w-4 h-4 text-[var(--color-accent)] shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-[var(--color-text-1)]">
                  {t('search.coord_detected')}
                </div>
                <div className="text-[12px] font-mono text-[var(--color-text-3)]">
                  {formatCoord(validCoord)}
                </div>
              </div>
            </button>
          )}

          {/* Loading */}
          {loading && (
            <div role="status" aria-live="polite" className="px-4 py-3 text-[13px] text-[var(--color-text-3)]">
              {t('search.searching')}
            </div>
          )}

          {/* Address results */}
          {results.map((r, i) => {
            const idx = resultIndexOffset + i
            return (
              <button
                key={`${coordKey(r, 6)}_${r.name}`}
                id={`search-opt-${i}`}
                role="option"
                aria-selected={activeIndex === idx}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => handleSelect(r.lat, r.lng)}
                disabled={!deviceConnected}
                title={!deviceConnected ? t('action.disabled_no_device') : undefined}
                className={[
                  'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors cursor-pointer',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  activeIndex === idx ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]',
                ].join(' ')}
              >
                <MapPin className="w-4 h-4 text-[var(--color-text-3)] shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] text-[var(--color-text-1)] truncate">
                    {r.name}
                  </div>
                  {r.address && (
                    <div className="text-[12px] text-[var(--color-text-3)] truncate">
                      {r.address}
                    </div>
                  )}
                </div>
              </button>
            )
          })}

          {/* Search failed — transport / backend error, distinct from empty results */}
          {!loading && error && (
            <div role="status" aria-live="polite" className="px-4 py-3 text-[13px] text-[var(--color-text-3)] text-center">
              {t('search.error')}
            </div>
          )}

          {/* No results */}
          {!loading && !error && results.length === 0 && !validCoord && query.trim().length >= 2 && (
            <div role="status" aria-live="polite" className="px-4 py-3 text-[13px] text-[var(--color-text-3)] text-center">
              {t('search.no_results')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
