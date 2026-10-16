export type HeldFile = { path: string; bytes: string };

export type FileEffect =
  | { kind: "reload"; id: string; path: string; bytes: string }
  | { kind: "moved"; id: string; path: string }
  | { kind: "conflict"; id: string; path: string; theirs: string | null }
  | { kind: "added"; id: string; path: string; bytes: string }
  | { kind: "removed"; id: string };

type Hold =
  | { kind: "tracked"; path: string; bytes: string }
  | { kind: "editing"; path: string; base: string }
  | { kind: "conflict"; path: string; base: string; diskPath: string; theirs: string | null };

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
    const hold = this.holds.get(id);
    return hold?.kind === "editing" || hold?.kind === "conflict";
  }

  conflict(id: string): boolean {
    return this.holds.get(id)?.kind === "conflict";
  }

  anyConflict(): boolean {
    for (const hold of this.holds.values()) {
      if (hold.kind === "conflict") return true;
    }
    return false;
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

  planSave(id: string, disk: string | null, next: string): { write: string | null } {
    const hold = this.holds.get(id);
    if (disk === next) {
      this.holds.set(id, { kind: "tracked", path: hold?.path ?? "", bytes: next });
      return { write: null };
    }
    if (hold?.kind === "conflict") {
      this.holds.set(id, { ...hold, theirs: disk });
      return { write: null };
    }
    const base = hold?.kind === "editing" ? hold.base : hold?.kind === "tracked" ? hold.bytes : null;
    const path = hold?.path ?? "";
    if (disk === base || (disk === null && base === null)) {
      this.holds.set(id, { kind: "tracked", path, bytes: next });
      return { write: next };
    }
    this.holds.set(id, { kind: "conflict", path, base: base ?? "", diskPath: path, theirs: disk });
    return { write: null };
  }

  keepMine(id: string, mine: string): { path: string; bytes: string; removePath: string | null } {
    const hold = this.holds.get(id);
    const memory = hold?.path ?? "";
    const diskPath = hold?.kind === "conflict" ? hold.diskPath : memory;
    const path = diskPath || memory;
    const removePath = path !== memory && memory !== "" ? memory : null;
    this.holds.set(id, { kind: "tracked", path, bytes: mine });
    return { path, bytes: mine, removePath };
  }

  matchesBase(id: string, disk: string | null): boolean {
    const hold = this.holds.get(id);
    if (!hold) return disk === null;
    if (hold.kind === "tracked") return disk === hold.bytes;
    return disk === hold.base;
  }

  keepOpenBuffer(id: string, reason: "token" | "revert", disk: string | null): boolean {
    const hold = this.holds.get(id);
    if (!hold || hold.kind === "tracked") return false;
    return !(reason === "revert" && this.matchesBase(id, disk));
  }

  revertToBase(id: string): string | null {
    const hold = this.holds.get(id);
    if (!hold || hold.kind === "conflict") return null;
    const bytes = hold.kind === "tracked" ? hold.bytes : hold.base;
    this.holds.set(id, { kind: "tracked", path: hold.path, bytes });
    return bytes;
  }

  takeTheirs(id: string): { path: string; bytes: string | null } {
    const hold = this.holds.get(id);
    if (hold?.kind === "conflict" && hold.theirs === null) {
      this.holds.delete(id);
      return { path: hold.diskPath || hold.path, bytes: null };
    }
    const bytes = hold?.kind === "conflict" ? hold.theirs : hold?.kind === "editing" ? hold.base : null;
    const path = hold?.kind === "conflict" ? hold.diskPath || hold.path : hold?.path ?? "";
    if (bytes === null) {
      this.holds.delete(id);
      return { path, bytes: null };
    }
    this.holds.set(id, { kind: "tracked", path, bytes });
    return { path, bytes };
  }
}

function observeOne(
  id: string,
  hold: Hold,
  disk: HeldFile | undefined,
): { hold: Hold | null; effect: FileEffect | null } {
  if (hold.kind === "tracked") return observeTracked(id, hold, disk);
  if (hold.kind === "editing") return observeEditing(id, hold, disk);
  return observeConflict(id, hold, disk);
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
  if (!disk || disk.bytes !== hold.base) {
    return {
      hold: {
        kind: "conflict",
        path: hold.path,
        base: hold.base,
        diskPath: disk?.path ?? hold.path,
        theirs: disk?.bytes ?? null,
      },
      effect: { kind: "conflict", id, path: disk?.path ?? hold.path, theirs: disk?.bytes ?? null },
    };
  }
  if (disk.path !== hold.path) {
    return {
      hold: { kind: "editing", path: disk.path, base: hold.base },
      effect: { kind: "moved", id, path: disk.path },
    };
  }
  return { hold, effect: null };
}

function observeConflict(
  id: string,
  hold: Extract<Hold, { kind: "conflict" }>,
  disk: HeldFile | undefined,
): { hold: Hold | null; effect: FileEffect | null } {
  const theirs = disk?.bytes ?? null;
  const diskPath = disk?.path ?? hold.diskPath;
  if (theirs === hold.theirs && diskPath === hold.diskPath) return { hold, effect: null };
  return {
    hold: { ...hold, diskPath, theirs },
    effect: { kind: "conflict", id, path: diskPath, theirs },
  };
}
