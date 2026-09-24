import { useEffect, useState } from 'react';
import pkg from '../../package.json';
import { useT } from '../i18n';
import { STORAGE_KEYS } from '../lib/storage-keys';
import { readJSON, writeJSON } from '../lib/local-storage';
import { openExternalOrDefault } from '../lib/open-external';
import Modal from './Modal';

const CURRENT = pkg.version;
const REPO = 'crazycat836/GeoMirage';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DISMISS_KEY = STORAGE_KEYS.updateDismissed;

// How long to trust a cached check before re-hitting the GitHub API. The
// release-poll endpoint has tight unauthenticated rate limits (60/h per
// IP), so we don't want every component re-mount to burn quota — once
// per hour is more than enough for an update prompt.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const LAST_CHECK_KEY = STORAGE_KEYS.updateLastCheck;

interface LastCheckCache {
  /** Epoch ms when we last fetched the GitHub releases endpoint. */
  at: number
  /** The newest tag returned at `at`, or `null` when the user is up to date. */
  latest: string | null
}

function readLastCheck(): LastCheckCache | null {
  const parsed = readJSON(LAST_CHECK_KEY) as { at?: unknown; latest?: unknown } | null;
  if (parsed == null) return null;
  if (typeof parsed.at !== 'number') return null;
  if (parsed.latest !== null && typeof parsed.latest !== 'string') return null;
  return { at: parsed.at, latest: parsed.latest };
}

function writeLastCheck(latest: string | null): void {
  writeJSON(LAST_CHECK_KEY, {
    at: Date.now(), latest,
  } satisfies LastCheckCache);
}

function parseVer(s: string): number[] {
  return s.replace(/^v/i, '').split('.').map((p) => parseInt(p, 10) || 0);
}

/** Returns true if `a` is strictly newer than `b`. */
function isNewer(a: string, b: string): boolean {
  const x = parseVer(a);
  const y = parseVer(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    if (xi !== yi) return xi > yi;
  }
  return false;
}

/**
 * Checks GitHub on mount for a newer release; shows a dismissible dialog
 * when one is found. Silent when already on the latest version or when
 * the network / API is unreachable. User-dismissed versions are cached
 * in localStorage for 6 hours to avoid nagging.
 */
export default function UpdateChecker() {
  const t = useT();
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let dismissedVersion: string | null = null;
      // Malformed cache — treat as not-dismissed.
      const parsed = readJSON(DISMISS_KEY) as { version?: unknown; at?: unknown } | null;
      if (parsed != null && typeof parsed.version === 'string' && typeof parsed.at === 'number' &&
          Date.now() - parsed.at < COOLDOWN_MS) {
        dismissedVersion = parsed.version;
      }

      // Reuse a recent check (incl. the "no update" outcome) instead of
      // re-hitting the GitHub API on every component mount.
      const cached = readLastCheck();
      const hasFreshCache = cached !== null &&
        Date.now() - cached.at < UPDATE_CHECK_INTERVAL_MS;
      if (hasFreshCache) {
        const tag = cached.latest;
        if (cancelled) return;
        if (!tag || !isNewer(tag, CURRENT)) return;
        if (dismissedVersion && parseVer(tag).join('.') === parseVer(dismissedVersion).join('.')) {
          return;
        }
        setLatest(tag);
        return;
      }

      try {
        const r = await fetch(API_URL, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!r.ok || cancelled) return;
        const data = await r.json();
        const tag: string | undefined = data?.tag_name;

        // Persist whichever outcome we got — `null` for "user is on the
        // latest version", or the tag string when there's an update — so
        // the next mount inside the interval window short-circuits.
        const cacheTag = tag && isNewer(tag, CURRENT) ? tag : null;
        writeLastCheck(cacheTag);

        if (!tag || !isNewer(tag, CURRENT)) return;

        // Respect an in-cooldown dismissal for this exact version; a
        // newer tag still shows so we don't strand users on a skipped
        // release forever.
        if (dismissedVersion && parseVer(tag).join('.') === parseVer(dismissedVersion).join('.')) {
          return;
        }
        setLatest(tag);
      } catch {
        // Offline / rate-limited / DNS — silent. Don't update the cache so
        // the next mount tries again rather than honouring a transient
        // failure for the full interval.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!latest) return null;

  const dismiss = () => {
    writeJSON(DISMISS_KEY, { version: latest, at: Date.now() });
    setLatest(null);
  };

  return (
    <Modal
      open
      onClose={dismiss}
      ariaLabel={t('update.title')}
      title={
        <span className="flex items-center gap-2.5">
          <span
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--color-accent), var(--color-device-a))' }}
            aria-hidden="true"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path d="M12 2v13M5 9l7-7 7 7" />
              <path d="M5 21h14" />
            </svg>
          </span>
          {t('update.title')}
        </span>
      }
      actions={
        <>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="action-btn primary flex-1 text-center no-underline inline-flex items-center justify-center gap-1.5"
            onClick={(e) => openExternalOrDefault(RELEASES_URL, e)}
          >
            {t('update.download')}
          </a>
          <button type="button" className="action-btn" onClick={dismiss}>
            {t('update.later')}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="flex justify-between">
          <span className="opacity-65">{t('update.current')}</span>
          <span className="font-mono">v{CURRENT}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="opacity-65">{t('update.latest')}</span>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[var(--color-accent)] font-semibold no-underline"
            onClick={(e) => openExternalOrDefault(RELEASES_URL, e)}
          >
            {latest} ↗
          </a>
        </div>
      </div>

      <p className="text-xs text-[var(--color-text-1)] opacity-75 mb-4 leading-relaxed">
        {t('update.go_to_github')}
      </p>
    </Modal>
  );
}
