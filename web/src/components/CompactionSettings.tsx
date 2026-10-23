import type { AppSettings } from '../../../shared/protocol';
import { compact } from '../lib/format';
import { Field, Select, Toggle } from './ui';

const WINDOWS = [150_000, 200_000, 300_000, 500_000];

/**
 * Auto-compact controls, rendered inside the "New session defaults" grid so they
 * share that form's state and Save button (it PUTs the whole settings object).
 */
export function CompactionFields({ s, up }: { s: AppSettings; up: <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => void }) {
  const windows = s.autoCompactWindow && !WINDOWS.includes(s.autoCompactWindow) ? [...WINDOWS, s.autoCompactWindow].sort((a, b) => a - b) : WINDOWS;
  return (
    <>
      <Field
        label="Auto-compact"
        hint={
          s.autoCompact
            ? 'When the context fills, Claude summarises older turns and keeps going. Your full history stays visible here.'
            : 'Off: compact by hand with /compact or the context meter. Turns fail once the window is full.'
        }
      >
        <span className="flex h-9 items-center">
          <Toggle checked={s.autoCompact} onChange={(v) => up('autoCompact', v)} label="Auto-compact" />
        </span>
      </Field>
      <Field
        label="Compaction window"
        hint="Claude compacts a little before this (it keeps ~33K in reserve). Smaller is cheaper and faster, since every turn re-reads the whole context; larger keeps more detail verbatim."
      >
        <Select
          value={s.autoCompactWindow ?? ''}
          onChange={(e) => up('autoCompactWindow', e.target.value ? Number(e.target.value) : null)}
          disabled={!s.autoCompact}
          className="w-full"
        >
          <option value="">The model's full window</option>
          {windows.map((n) => (
            <option key={n} value={n}>
              {compact(n)} tokens
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}
