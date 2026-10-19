/**
 * Phase M's NPCs (docs/office/DESIGN.md): the user's own chibi, "Ansh", at
 * the desk in the `Ansh` Area, and the Manager at the desk outside it.
 *
 * Like the consent greeter they are deliberately NOT in OfficeState's
 * `characters`: that map means "agents", and everything that iterates it —
 * seat assignment, palette diversity, the card bars and counts, hit-testing
 * for selection, the seat payload — gets agents only, correct by default.
 * They join the drawing at OfficeState.getCharacters(), and their seats are
 * held (`seat.assigned`) so no agent is ever given one.
 */

import {
  ANSH_NPC_HUE_SHIFT,
  ANSH_NPC_ID,
  ANSH_NPC_PALETTE,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  KNOCK_BOB_DURATION_SEC,
  KNOCK_BOB_OFFSETS_SEC,
  KNOCK_BOB_PX,
  KNOCK_INTERVAL_SEC,
  MANAGER_NPC_HUE_SHIFT,
  MANAGER_NPC_ID,
  MANAGER_NPC_PALETTE,
  MANAGER_VISIT_STAY_SEC,
  NPC_IDLE_FRAME_SEC,
} from '../../constants.js';
import type { NpcPlaces, StandPlace } from '../anshOffice.js';
import { NO_NPC_PLACES } from '../anshOffice.js';
import type { Character, Seat, TileType as TileTypeVal, ZoneTarget } from '../types.js';
import { CharacterState, Direction, TILE_SIZE } from '../types.js';
import { ZoneLabel } from '../zones.js';
import { createCharacter, isSettledAtZoneTarget, updateCharacter } from './characters.js';

export type NpcKind = 'ansh' | 'manager';

/** What the NPCs need from the office each frame to walk about. */
export interface NpcWorld {
  walkableTiles: Array<{ col: number; row: number }>;
  seats: Map<string, Seat>;
  tileMap: TileTypeVal[][];
  blockedTiles: Set<string>;
}

type VisitPhase = 'going' | 'staying' | 'returning';

/** One of Ansh's errands (a thought's move, ansh/anshStore.ts): walk to a
 *  spot, stay a while facing what he came for, walk back to his desk. */
interface AnshErrand {
  phase: VisitPhase;
  timer: number;
  staySec: number;
  /** The tile he came for (an agent, the Manager): faced while he stays. */
  lookAt: () => { col: number; row: number } | null;
  hooks: AnshErrandHooks;
  /** onLeave has run (it runs once). */
  left: boolean;
}

/** What an errand's owner hears of it (OfficeState's between-thoughts errands). */
export interface AnshErrandHooks {
  /** He got there: the stay begins. */
  onArrive?: () => void;
  /** The stay is over, or won't happen: `stayed` is true when he stayed it
   *  out, false when he couldn't get there or another errand replaced it.
   *  Runs once per errand. */
  onLeave?: (stayed: boolean) => void;
}

/** One frame of an NPC's walk, with its own seat counted walkable. */
type WalkStep = 'walking' | 'arrived' | 'unreachable';

const seatTarget = (seat: Seat): ZoneTarget => ({
  zone: null,
  key: seat.uid,
  col: seat.seatCol,
  row: seat.seatRow,
  facing: seat.facingDir,
  sit: true,
  shared: true,
});

const standTarget = (key: string, p: StandPlace): ZoneTarget => ({
  zone: null,
  key,
  col: p.col,
  row: p.row,
  facing: p.facing,
  sit: false,
  shared: true,
});

function placeAt(ch: Character, t: ZoneTarget): void {
  ch.tileCol = t.col;
  ch.tileRow = t.row;
  ch.x = t.col * TILE_SIZE + TILE_SIZE / 2;
  ch.y = t.row * TILE_SIZE + TILE_SIZE / 2;
  ch.dir = t.facing;
  ch.path = [];
  ch.moveProgress = 0;
  ch.state = t.sit ? CharacterState.TYPE : CharacterState.IDLE;
  ch.frame = 0;
  ch.frameTimer = 0;
}

function createNpc(id: number, palette: number, hueShift: number, home: ZoneTarget): Character {
  const ch = createCharacter(id, palette, null, null, hueShift);
  ch.isActive = false;
  placeAt(ch, home);
  return ch;
}

export class OfficeNpcs {
  readonly ansh: Character | null;
  readonly manager: Character | null;
  /** Hovered NPC (the name label shows), set by the canvas. */
  hovered: NpcKind | null = null;
  private readonly places: NpcPlaces;
  private readonly managerHome: ZoneTarget | null;
  private readonly anshHome: ZoneTarget | null;
  private visit: { phase: VisitPhase; timer: number } | null = null;
  private errand: AnshErrand | null = null;

  constructor(places: NpcPlaces = NO_NPC_PLACES) {
    this.places = places;
    this.anshHome = places.anshSeat ? seatTarget(places.anshSeat) : null;
    this.ansh = this.anshHome
      ? createNpc(ANSH_NPC_ID, ANSH_NPC_PALETTE, ANSH_NPC_HUE_SHIFT, this.anshHome)
      : null;
    this.managerHome = places.managerSeat
      ? seatTarget(places.managerSeat)
      : places.managerStand
        ? standTarget('npc:manager-home', places.managerStand)
        : null;
    this.manager = this.managerHome
      ? createNpc(MANAGER_NPC_ID, MANAGER_NPC_PALETTE, MANAGER_NPC_HUE_SHIFT, this.managerHome)
      : null;
  }

  /** Seat uids held for the NPCs — every seat in the Ansh and Manager
   *  Areas — so no seat picker ever hands one to an agent. */
  seatIds(): string[] {
    return this.places.heldSeatIds;
  }

  /** Mark the NPC seats taken (after the office resets every seat). */
  reserveSeats(seats: Map<string, Seat>): void {
    for (const uid of this.seatIds()) {
      const seat = seats.get(uid);
      if (seat) seat.assigned = true;
    }
  }

  characters(): Character[] {
    const out: Character[] = [];
    if (this.ansh) out.push(this.ansh);
    if (this.manager) out.push(this.manager);
    return out;
  }

  /** The Manager is on its way to Ansh's desk, there, or on its way back. */
  get visiting(): boolean {
    return this.visit !== null;
  }

  /** Report time: the Manager walks into Ansh's office, stands by the desk a
   *  while, then walks back. False (nothing happens) without a Manager or a
   *  spot to stand in the office; a visit already under way just goes on. */
  startManagerVisit(): boolean {
    const ch = this.manager;
    const spot = this.places.visitSpot;
    if (!ch || !spot) return false;
    if (this.visit) return true;
    this.visit = { phase: 'going', timer: 0 };
    this.walkTo(ch, standTarget('npc:manager-visit', spot));
    return true;
  }

  /** Ansh is out of his chair on an errand (going, there, or coming back). */
  get anshOut(): boolean {
    return this.errand !== null;
  }

  /**
   * A thought's move: Ansh walks to `spot`, stays `staySec` facing what
   * `lookAt` returns, then walks back to his desk. A new errand replaces one
   * under way (he sets off from wherever he is). False without an Ansh.
   */
  startAnshErrand(
    spot: { col: number; row: number },
    staySec: number,
    lookAt: () => { col: number; row: number } | null,
    hooks: AnshErrandHooks = {},
  ): boolean {
    const ch = this.ansh;
    if (!ch || !this.anshHome) return false;
    if (this.errand) leaveErrand(this.errand, false);
    this.errand = { phase: 'going', timer: 0, staySec, lookAt, hooks, left: false };
    const facing = faceToward(spot, lookAt() ?? spot, ch.dir);
    this.walkTo(ch, standTarget('npc:ansh-errand', { ...spot, facing }));
    return true;
  }

  update(dt: number, world: NpcWorld): void {
    this.updateAnsh(dt, world);
    const ch = this.manager;
    const home = this.managerHome;
    if (!ch || !home) return;
    const visit = this.visit;
    if (!visit) {
      idleAnimate(ch, dt);
      return;
    }
    if (visit.phase === 'staying') {
      visit.timer += dt;
      if (visit.timer >= MANAGER_VISIT_STAY_SEC) {
        visit.phase = 'returning';
        this.walkTo(ch, home);
      }
      return;
    }
    const step = stepWalk(ch, this.places.managerSeat, dt, world);
    if (step === 'unreachable') {
      // No way there (or back): give up and sit back down.
      this.visit = null;
      ch.zoneTarget = null;
      placeAt(ch, home);
      return;
    }
    if (step === 'walking') return;
    if (visit.phase === 'going') {
      visit.phase = 'staying';
      visit.timer = 0;
      return;
    }
    // Back home.
    this.visit = null;
    ch.zoneTarget = null;
    placeAt(ch, home);
  }

  private updateAnsh(dt: number, world: NpcWorld): void {
    const ch = this.ansh;
    const home = this.anshHome;
    if (!ch) return;
    const errand = this.errand;
    if (!errand || !home) {
      idleAnimate(ch, dt);
      return;
    }
    if (errand.phase === 'staying') {
      // Keep facing what he came for (an agent may have moved).
      const at = errand.lookAt();
      if (at) ch.dir = faceToward({ col: ch.tileCol, row: ch.tileRow }, at, ch.dir);
      errand.timer += dt;
      if (errand.timer >= errand.staySec) {
        errand.phase = 'returning';
        this.walkTo(ch, home);
        leaveErrand(errand, true);
      }
      return;
    }
    const step = stepWalk(ch, this.places.anshSeat, dt, world);
    if (step === 'unreachable') {
      // No way there (or back): he stays put at his desk.
      leaveErrand(errand, false);
      this.errand = null;
      ch.zoneTarget = null;
      placeAt(ch, home);
      return;
    }
    if (step === 'walking') return;
    if (errand.phase === 'going') {
      errand.phase = 'staying';
      errand.timer = 0;
      errand.hooks.onArrive?.();
      return;
    }
    // Back at his desk.
    this.errand = null;
    ch.zoneTarget = null;
    placeAt(ch, home);
  }

  /** The NPC under a world point (the same box as an agent's hit test). */
  hitTest(worldX: number, worldY: number): NpcKind | null {
    const hit = (ch: Character | null) => {
      if (!ch) return false;
      const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      const anchorY = ch.y + sittingOffset;
      return (
        worldX >= ch.x - CHARACTER_HIT_HALF_WIDTH &&
        worldX <= ch.x + CHARACTER_HIT_HALF_WIDTH &&
        worldY >= anchorY - CHARACTER_HIT_HEIGHT &&
        worldY <= anchorY
      );
    };
    // Front-most first (larger y draws in front).
    const order = this.characters().sort((a, b) => b.y - a.y);
    for (const ch of order) {
      if (hit(ch)) return ch === this.manager ? 'manager' : 'ansh';
    }
    return null;
  }

  /** The character of an NPC kind, or null. */
  characterOf(kind: NpcKind | null): Character | null {
    if (kind === 'ansh') return this.ansh;
    if (kind === 'manager') return this.manager;
    return null;
  }

  private walkTo(ch: Character, target: ZoneTarget): void {
    ch.zoneTarget = { ...target };
    ch.path = [];
    ch.moveProgress = 0;
    // The FSM's zone branch finds the path on the next update.
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
  }
}

/** End an errand's stay for its owner, once. */
function leaveErrand(errand: AnshErrand, stayed: boolean): void {
  if (errand.left) return;
  errand.left = true;
  errand.hooks.onLeave?.(stayed);
}

/**
 * One frame of an NPC's walk under the FSM's zone branch, with its own seat
 * counted walkable (chairs are blocked to everyone else).
 */
function stepWalk(ch: Character, ownSeat: Seat | null, dt: number, world: NpcWorld): WalkStep {
  const ownKey = ownSeat ? `${ownSeat.seatCol},${ownSeat.seatRow}` : null;
  const removed = ownKey !== null && world.blockedTiles.delete(ownKey);
  try {
    updateCharacter(ch, dt, world.walkableTiles, world.seats, world.tileMap, world.blockedTiles);
  } finally {
    if (removed && ownKey) world.blockedTiles.add(ownKey);
  }
  if (ch.zoneTarget?.unreachable) return 'unreachable';
  return isSettledAtZoneTarget(ch) ? 'arrived' : 'walking';
}

/** The direction from one tile to look at another (the larger axis wins). */
export function faceToward(
  from: { col: number; row: number },
  to: { col: number; row: number },
  fallback: Direction,
): Direction {
  const dc = to.col - from.col;
  const dr = to.row - from.row;
  if (dc === 0 && dr === 0) return fallback;
  if (Math.abs(dc) >= Math.abs(dr)) return dc > 0 ? Direction.RIGHT : Direction.LEFT;
  return dr > 0 ? Direction.DOWN : Direction.UP;
}

/** Seated (or standing) at home: a slow two-frame loop, so they look alive. */
function idleAnimate(ch: Character, dt: number): void {
  ch.frameTimer += dt;
  if (ch.frameTimer >= NPC_IDLE_FRAME_SEC) {
    ch.frameTimer -= NPC_IDLE_FRAME_SEC;
    ch.frame = (ch.frame + 1) % 2;
  }
}

/**
 * The knock: an agent settled at Ansh's door (a permission request) bobs up
 * KNOCK_BOB_PX twice — knock knock — every KNOCK_INTERVAL_SEC. World px to
 * lift the sprite by this frame (0 between knocks and for everyone else).
 */
export function knockBobPx(ch: Character): number {
  if (ch.zoneTarget?.zone !== ZoneLabel.ANSH || !isSettledAtZoneTarget(ch)) return 0;
  const t = (ch.zoneFxTimer ?? 0) % KNOCK_INTERVAL_SEC;
  return KNOCK_BOB_OFFSETS_SEC.some((at) => t >= at && t < at + KNOCK_BOB_DURATION_SEC)
    ? KNOCK_BOB_PX
    : 0;
}
