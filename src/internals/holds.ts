export type HeldFile = { path: string; bytes: string };

export type FileEffect =
  | { kind: "reload"; id: string; path: string; bytes: string }
  | { kind: "moved"; id: string; path: string }
  | { kind: "added"; id: string; path: string; bytes: string }
  | { kind: "removed"; id: string };

type Hold =
  | { kind: "tracked"; path: string; bytes: string }
  | { kind: "editing"; path: string; base: string | null };

export type SaveInstall = "hold" | "same" | "write";

/**
 * Install `snapshot` only when the companion is idle and the buffer is still
 * that capture. A busy companion, a moved buffer, or bytes we have not
 * accepted are held.
 */
export function saveInstall(input: {
  busy: boolean;
  base: string | null;
  disk: string | null;
  diskNow: string | null;
  snapshot: string;
  buffer: string;
}): SaveInstall {
  if (heldBack(input)) return "hold";
  if (input.disk === input.snapshot) return "same";
  return "write";
}

/** Show companion bytes only when the open buffer is still the base. */
export function installDisk(input: {
  base: string | null;
  snapshot: string | null;
  buffer: string | null;
}): "install" | "hold" {
  if (input.snapshot === null || input.buffer === null) return "install";
  if (input.buffer !== input.snapshot) return "hold";
  if (input.snapshot !== input.base) return "hold";
  return "install";
}

export function hasNewRefresh(applied: string | null, token: string | null): boolean {
  return token !== null && token !== applied;
}

export class FileHolds {
  private holds = new Map<string, Hold>();

  replaceAll(files: ReadonlyMap<string, HeldFile>): void {
    this.holds = new Map(
      [...files].map(([id, file]) => [id, { kind: "tracked", path: file.path, bytes: file.bytes }]),
    );
  }

  markEditing(id: string): void {
    const hold = this.holds.get(id);
    if (!hold || hold.kind !== "tracked") return;
    this.holds.set(id, { kind: "editing", path: hold.path, base: hold.bytes });
  }

  ensureTracked(id: string, file: HeldFile): void {
    if (this.holds.has(id)) return;
    this.holds.set(id, { kind: "tracked", path: file.path, bytes: file.bytes });
  }

  editing(id: string): boolean {
    return this.holds.get(id)?.kind === "editing";
  }

  base(id: string): string | null {
    const hold = this.holds.get(id);
    if (!hold) return null;
    if (hold.kind === "tracked") return hold.bytes;
    return hold.base;
  }

  /** The companion finished. The buffer stays; later saves may replace these bytes. */
  acceptDisk(id: string, path: string, disk: string | null): void {
    this.holds.set(id, { kind: "editing", path, base: disk });
  }

  noteWrite(id: string, path: string, bytes: string): void {
    this.holds.set(id, { kind: "tracked", path, bytes });
  }

  observe(files: ReadonlyMap<string, HeldFile>): readonly FileEffect[] {
    const effects: FileEffect[] = [];
    const seen = new Set<string>();
    for (const [id, hold] of this.holds) {
      seen.add(id);
      const disk = files.get(id);
      const effect = observeOne(id, hold, disk);
      if (effect.hold) this.holds.set(id, effect.hold);
      else this.holds.delete(id);
      if (effect.effect) effects.push(effect.effect);
    }
    for (const [id, file] of files) {
      if (seen.has(id)) continue;
      this.holds.set(id, { kind: "tracked", path: file.path, bytes: file.bytes });
      effects.push({ kind: "added", id, path: file.path, bytes: file.bytes });
    }
    return effects;
  }
}

function heldBack(input: {
  busy: boolean;
  base: string | null;
  disk: string | null;
  diskNow: string | null;
  snapshot: string;
  buffer: string;
}): boolean {
  if (input.busy) return true;
  if (input.buffer !== input.snapshot) return true;
  if (input.diskNow !== input.disk) return true;
  return input.disk !== input.base && input.disk !== input.snapshot;
}

function observeOne(
  id: string,
  hold: Hold,
  disk: HeldFile | undefined,
): { hold: Hold | null; effect: FileEffect | null } {
  if (hold.kind === "tracked") return observeTracked(id, hold, disk);
  return observeEditing(id, hold, disk);
}

function observeTracked(
  id: string,
  hold: Extract<Hold, { kind: "tracked" }>,
  disk: HeldFile | undefined,
): { hold: Hold | null; effect: FileEffect | null } {
  if (!disk) return { hold: null, effect: { kind: "removed", id } };
  if (disk.bytes === hold.bytes && disk.path !== hold.path) {
    return {
      hold: { kind: "tracked", path: disk.path, bytes: hold.bytes },
      effect: { kind: "moved", id, path: disk.path },
    };
  }
  if (disk.bytes !== hold.bytes) {
    return {
      hold: { kind: "tracked", path: disk.path, bytes: disk.bytes },
      effect: { kind: "reload", id, path: disk.path, bytes: disk.bytes },
    };
  }
  return { hold, effect: null };
}

function observeEditing(
  id: string,
  hold: Extract<Hold, { kind: "editing" }>,
  disk: HeldFile | undefined,
): { hold: Hold | null; effect: FileEffect | null } {
  if (!disk) return { hold: null, effect: { kind: "removed", id } };
  if (disk.bytes !== hold.base) {
    return { hold: { kind: "editing", path: disk.path, base: hold.base }, effect: null };
  }
  if (disk.path !== hold.path) {
    return {
      hold: { kind: "editing", path: disk.path, base: hold.base },
      effect: { kind: "moved", id, path: disk.path },
    };
  }
  return { hold, effect: null };
}
