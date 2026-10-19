// Wallet Tracker alerts, on every page: when a wallet in a group with alerts on trades (at or above
// the group's min value), a banner drops in at the top of the screen and closes by itself after the
// group's duration (a bar shows the time left; hovering holds it), with the group's sound.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from '../router.jsx';
import { mergeTrades, useFollowedTrades } from '../lib/liveFeed.js';
import { useTrackedWallets } from '../lib/walletTracker.js';
import { getTokens } from '../lib/tokens.js';
import { formatUsd } from '../lib/format.js';
import { NATIVE_NEAR } from '../config.js';
import { TokenIcon } from './ui.jsx';

export const TRACKER_SOUNDS = [
  { key: 'chime', label: 'Chime' },
  { key: 'coin', label: 'Coin' },
  { key: 'bubble', label: 'Bubble' },
  { key: 'bell', label: 'Bell' },
  { key: 'none', label: 'None' }
];

/** A group's sound: older saves kept true / false. */
export const soundOf = (group) => (group.sound === true ? 'chime' : group.sound === false || !group.sound ? 'none' : group.sound);

let ctx = null;

/** One note: frequency, start offset and length in seconds, wave type, loudness. */
function note(out, freq, at, length, type = 'sine', level = 1, glideTo = null) {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, at + length);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(level, at + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

/** Plays a tracker sound (synthesised, no files) at `volume` 0–100. Browsers allow it after a first click. */
export function playTrackerSound(kind = 'chime', volume = 80) {
  if (kind === 'none' || !volume) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const out = ctx.createGain();
    out.gain.value = Math.min(1, volume / 100) * 0.35;
    out.connect(ctx.destination);
    const t = ctx.currentTime + 0.01;
    if (kind === 'coin') {
      // Two quick bright notes, like a coin pickup.
      note(out, 988, t, 0.09, 'square', 0.35);
      note(out, 1319, t + 0.08, 0.38, 'square', 0.35);
    } else if (kind === 'bubble') {
      // Two rising pops.
      note(out, 420, t, 0.12, 'sine', 1, 900);
      note(out, 620, t + 0.11, 0.14, 'sine', 1, 1300);
    } else if (kind === 'bell') {
      // A bell: a note and its overtones, ringing out.
      [
        [880, 1],
        [1760, 0.45],
        [2640, 0.2],
        [3520, 0.12]
      ].forEach(([f, l]) => note(out, f, t, 1.4, 'sine', l));
    } else {
      // Chime: three soft rising notes (E6, G#6, B6) with a gentle tail.
      [1319, 1661, 1976].forEach((f, i) => {
        note(out, f, t + i * 0.09, 0.55, 'sine', 0.8);
        note(out, f * 2, t + i * 0.09, 0.25, 'sine', 0.12);
      });
    }
  } catch {
    // no audio here
  }
}

const MAX_SHOWN = 3;

function AlertBanner({ alert, onClose }) {
  const [hold, setHold] = useState(false);
  const left = useRef(alert.seconds * 1000);
  // Closes when the time runs out; hovering (or touching) pauses it.
  useEffect(() => {
    if (hold) return undefined;
    const started = Date.now();
    const timer = setTimeout(() => onClose(alert.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - started;
    };
  }, [hold, alert.id, onClose]);
  const buy = alert.side === 'buy';
  return (
    <div
      className={`tk-alert tk-alert--${buy ? 'buy' : 'sell'}`}
      role="status"
      onMouseEnter={() => setHold(true)}
      onMouseLeave={() => setHold(false)}
      onTouchStart={() => setHold(true)}
      onTouchEnd={() => setHold(false)}
    >
      <i className="tk-alert__who" style={{ background: alert.color }}>
        {alert.emoji || alert.label[0]?.toUpperCase()}
      </i>
      <div className="tk-alert__text">
        <strong>
          {alert.label} <span className={buy ? 'up' : 'down'}>{buy ? 'bought' : 'sold'}</span> {formatUsd(alert.usd)}
          {alert.count > 1 && <span className="tk-alert__count"> ({alert.count}×)</span>} <span className="tk-alert__of">of ${alert.token.symbol}</span>
        </strong>
        <small>
          {alert.groupEmoji} {alert.group} · Wallet Tracker
        </small>
      </div>
      <Link className="tk-alert__token" to={`/token/${encodeURIComponent(alert.token.id)}`} onClick={() => onClose(alert.id)}>
        <TokenIcon token={alert.token} size={22} />${alert.token.symbol}
      </Link>
      <Link className="button button--primary button--sm" to={`/swap?from=${NATIVE_NEAR.id}&to=${encodeURIComponent(alert.token.id)}`} onClick={() => onClose(alert.id)}>
        Trade
      </Link>
      <button type="button" className="tk-alert__close" aria-label="Dismiss" onClick={() => onClose(alert.id)}>
        ✕
      </button>
      <span className="tk-alert__time" style={{ animationDuration: `${alert.seconds}s`, animationPlayState: hold ? 'paused' : 'running' }} />
    </div>
  );
}

export default function TrackerAlerts() {
  const { wallets, groups } = useTrackedWallets();
  const watched = useMemo(() => {
    const on = new Map(groups.filter((g) => g.alerts).map((g) => [g.id, g]));
    return wallets.filter((w) => on.has(w.group)).map((w) => ({ ...w, groupConf: on.get(w.group) }));
  }, [wallets, groups]);
  const byId = useMemo(() => new Map(watched.map((w) => [w.id, w])), [watched]);
  const followed = useFollowedTrades(watched.length > 0, watched.map((w) => w.id));
  const [alerts, setAlerts] = useState([]);
  const close = useCallback((id) => setAlerts((list) => list.filter((a) => a.id !== id)), []);

  // The first load is history: only trades seen after it alert.
  const seen = useRef(null);
  const key = watched.map((w) => w.id).join(',');
  useEffect(() => {
    seen.current = null;
  }, [key]);

  useEffect(() => {
    if (followed.loading && !followed.trades.length) return;
    const trades = mergeTrades(followed.trades);
    if (!seen.current) {
      seen.current = new Set(trades.map((t) => t.id));
      return;
    }
    const fresh = trades.filter((t) => !seen.current.has(t.id));
    fresh.forEach((t) => seen.current.add(t.id));
    // Trades of one wallet in one token and direction since the last check (a swap split across
    // pools, a bot's burst) make one alert: summed, with a count.
    const merged = new Map();
    for (const t of fresh) {
      if (!byId.has(t.trader)) continue;
      const k = `${t.trader}|${t.token}|${t.side}`;
      const prev = merged.get(k);
      merged.set(k, prev ? { ...prev, usd: prev.usd + t.usd, count: prev.count + 1 } : { ...t, count: 1 });
    }
    const hits = [...merged.values()].filter((t) => t.usd >= (Number(byId.get(t.trader).groupConf.minUsd) || 0));
    if (!hits.length) return;
    getTokens([...new Set(hits.map((t) => t.token))])
      .catch(() => ({}))
      .then((meta) => {
        const next = hits.slice(0, MAX_SHOWN).map((t) => {
          const w = byId.get(t.trader);
          const token = meta?.[t.token] || { id: t.token, symbol: String(t.token).split('.')[0].slice(0, 10) };
          return {
            id: t.id,
            side: t.side,
            usd: t.usd,
            count: t.count,
            token: { ...token, id: t.token },
            label: w.label,
            emoji: w.emoji,
            color: w.color,
            group: w.groupConf.name,
            groupEmoji: w.groupConf.emoji,
            seconds: Math.max(2, Number(w.groupConf.seconds) || 5)
          };
        });
        setAlerts((list) => [...next, ...list].slice(0, MAX_SHOWN));
        const loud = hits.map((t) => byId.get(t.trader).groupConf).find((g) => soundOf(g) !== 'none');
        if (loud) playTrackerSound(soundOf(loud), loud.volume);
      });
  }, [followed.trades, followed.loading, byId]);

  if (!alerts.length) return null;
  return createPortal(
    <div className="tk-alerts" aria-live="polite">
      {alerts.map((a) => (
        <AlertBanner key={a.id} alert={a} onClose={close} />
      ))}
    </div>,
    document.body
  );
}
