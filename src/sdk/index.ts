import type {
  Agent,
  AgentType,
  Decision,
  FileOwnership,
  Goals,
  ProjectInfo,
  State,
  StatedEvent,
  SyncReport,
  Task,
  TaskPriority,
} from "../core/index.js";
import {
  init as coreInit,
  findProjectRoot,
  requireProjectRoot,
  isInitialized,
  buildState,
  generateHandoff,
  createSnapshot,
  regenerate,
  readProject,
  writeProject,
  readGoals,
  addGoal as coreAddGoal,
  completeGoal as coreCompleteGoal,
  readTasks,
  getTask,
  addTask as coreAddTask,
  claimTask as coreClaimTask,
  startTask as coreStartTask,
  completeTask as coreCompleteTask,
  blockTask as coreBlockTask,
  updateTask as coreUpdateTask,
  readDecisions,
  addDecision as coreAddDecision,
  readAgents,
  registerAgent as coreRegisterAgent,
  touchAgent,
  readFiles,
  claimFile as coreClaimFile,
  releaseFile as coreReleaseFile,
  verifyTask as coreVerifyTask,
  verifyFile as coreVerifyFile,
  fileOwner,
  applyDecay,
  syncProject,
  loadConfig,
  type StatedConfig,
  type DecayReport,
  readEvents,
  searchProject,
  doctor as coreDoctor,
  type SearchHit,
  type SearchOptions,
  type AddTaskInput,
  type UpdateTaskInput,
  type AddDecisionInput,
  type InitOptions,
  type DoctorReport,
} from "../core/index.js";

export interface StatedOptions {
  /**
   * Project root containing `.stated/`. If omitted, the root is discovered by
   * walking up from `cwd`.
   */
  cwd?: string;
  /**
   * Identity of the calling agent. When set, every mutation is attributed to
   * this name and the agent's `lastSeen` heartbeat is refreshed.
   */
  agent?: string;
  /**
   * Session/run scope. When set, created tasks/decisions are tagged with this
   * run id, and the `*InRun` helpers filter to it. Lets one project carry
   * parallel work streams.
   */
  run?: string;
}

/**
 * Programmatic interface to a Stated project.
 *
 * ```ts
 * import { Stated } from "stated";
 *
 * const stated = new Stated({ agent: "Claude Code" });
 * const state = await stated.getState();
 * const handoff = await stated.getHandoff();
 * await stated.claimTask("t_a1b2c3d4");
 * ```
 *
 * The API is async to keep the door open for future remote backends, but the
 * current implementation is backed by fast synchronous file IO.
 */
export class Stated {
  private readonly cwd: string;
  /** The agent identity used to attribute mutations, if any. */
  readonly agent: string | undefined;
  /** The session/run scope applied to created tasks/decisions, if any. */
  readonly run: string | undefined;

  constructor(options: StatedOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.agent = options.agent;
    this.run = options.run;
  }

  /** Resolve the project root, throwing if Stated is not initialized. */
  get root(): string {
    return requireProjectRoot(this.cwd);
  }

  /** Whether a `.stated/` directory exists at or above the cwd. */
  isInitialized(): boolean {
    return isInitialized(this.cwd);
  }

  /** The project root, or `null` if uninitialized. */
  findRoot(): string | null {
    return findProjectRoot(this.cwd);
  }

  /** Heartbeat the configured agent (no-op if none set or unregistered). */
  private touch(): void {
    if (this.agent) touchAgent(this.root, this.agent);
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Initialize `.stated/` in the cwd (or `options`-provided root). */
  async init(options: InitOptions = {}): Promise<string> {
    const result = coreInit(this.cwd, options);
    return result.root;
  }

  /** Read the compact machine state (`state.json`), freshly computed. */
  async getState(): Promise<State> {
    return buildState(this.root);
  }

  /** Read the project status: state plus a one-line summary. */
  async status(): Promise<State> {
    return buildState(this.root);
  }

  /** Generate and return the handoff document. */
  async getHandoff(): Promise<string> {
    return generateHandoff(this.root);
  }

  /** Alias of {@link getHandoff} for parity with the CLI verb. */
  async generateHandoff(): Promise<string> {
    return generateHandoff(this.root);
  }

  /** Force a regeneration of derived files and return the new state. */
  async refresh(): Promise<State> {
    return regenerate(this.root);
  }

  /** Write a timestamped restore point; returns the snapshot directory. */
  async snapshot(): Promise<string> {
    return createSnapshot(this.root);
  }

  /** Run integrity diagnostics. */
  async doctor(): Promise<DoctorReport> {
    return coreDoctor(this.root);
  }

  // --- Project ---------------------------------------------------------------

  async getProject(): Promise<ProjectInfo> {
    return readProject(this.root);
  }

  async setProject(info: ProjectInfo): Promise<void> {
    writeProject(this.root, info);
    regenerate(this.root);
  }

  // --- Goals -----------------------------------------------------------------

  async getGoals(): Promise<Goals> {
    return readGoals(this.root);
  }

  async addGoal(goal: string): Promise<Goals> {
    this.touch();
    const result = coreAddGoal(this.root, goal, this.agent);
    regenerate(this.root);
    return result;
  }

  async completeGoal(query: string): Promise<Goals> {
    this.touch();
    const result = coreCompleteGoal(this.root, query, this.agent);
    regenerate(this.root);
    return result;
  }

  // --- Agents ----------------------------------------------------------------

  async getAgents(): Promise<Agent[]> {
    return readAgents(this.root);
  }

  /** Register an agent. Defaults to the SDK's configured agent identity. */
  async registerAgent(name?: string, type?: AgentType): Promise<Agent> {
    const who = name ?? this.agent;
    if (!who)
      throw new Error("registerAgent requires a name or a configured agent.");
    return coreRegisterAgent(this.root, who, type);
  }

  // --- Tasks -----------------------------------------------------------------

  async getTasks(): Promise<Task[]> {
    const tasks = readTasks(this.root);
    return this.run ? tasks.filter((t) => t.runId === this.run) : tasks;
  }

  async getTask(id: string): Promise<Task | undefined> {
    return getTask(this.root, id);
  }

  async addTask(input: AddTaskInput | string): Promise<Task> {
    this.touch();
    const base: AddTaskInput =
      typeof input === "string" ? { title: input } : { ...input };
    // The configured run scope applies unless the call overrides it.
    const normalized: AddTaskInput =
      this.run && base.runId === undefined
        ? { ...base, runId: this.run }
        : base;
    return coreAddTask(this.root, normalized, this.agent);
  }

  /** Claim a task. Owner defaults to the configured agent. */
  async claimTask(
    id: string,
    owner?: string,
    opts: { force?: boolean } = {},
  ): Promise<Task> {
    const who = owner ?? this.agent;
    if (!who)
      throw new Error("claimTask requires an owner or a configured agent.");
    this.touch();
    return coreClaimTask(this.root, id, who, opts);
  }

  async startTask(id: string): Promise<Task> {
    this.touch();
    return coreStartTask(this.root, id, this.agent);
  }

  async completeTask(id: string): Promise<Task> {
    this.touch();
    return coreCompleteTask(this.root, id, this.agent);
  }

  async blockTask(id: string, reason?: string): Promise<Task> {
    this.touch();
    return coreBlockTask(this.root, id, reason, this.agent);
  }

  async updateTask(id: string, patch: UpdateTaskInput): Promise<Task> {
    this.touch();
    return coreUpdateTask(this.root, id, patch, this.agent);
  }

  // --- Decisions -------------------------------------------------------------

  async getDecisions(): Promise<Decision[]> {
    const decisions = readDecisions(this.root);
    return this.run ? decisions.filter((d) => d.runId === this.run) : decisions;
  }

  async addDecision(input: AddDecisionInput | string): Promise<Decision> {
    this.touch();
    const base: AddDecisionInput =
      typeof input === "string" ? { decision: input } : { ...input };
    const normalized: AddDecisionInput =
      this.run && base.runId === undefined
        ? { ...base, runId: this.run }
        : base;
    return coreAddDecision(this.root, normalized, this.agent);
  }

  // --- Files -----------------------------------------------------------------

  async getFiles(): Promise<FileOwnership[]> {
    return readFiles(this.root);
  }

  /** Claim/lock a file. Owner defaults to the configured agent. */
  async claimFile(
    path: string,
    owner?: string,
    opts: { lock?: boolean; force?: boolean } = {},
  ): Promise<FileOwnership> {
    const who = owner ?? this.agent;
    if (!who)
      throw new Error("claimFile requires an owner or a configured agent.");
    this.touch();
    return coreClaimFile(this.root, path, who, opts);
  }

  async releaseFile(
    path: string,
    opts: { force?: boolean } = {},
  ): Promise<boolean> {
    this.touch();
    return coreReleaseFile(this.root, path, {
      ...(this.agent ? { owner: this.agent } : {}),
      ...opts,
    });
  }

  // --- Freshness / decay -----------------------------------------------------

  /** Re-confirm a task is still accurate (refreshes its staleness clock). */
  async verifyTask(id: string): Promise<Task> {
    this.touch();
    return coreVerifyTask(this.root, id, this.agent);
  }

  /** Re-confirm a file claim is still active (refreshes its staleness clock). */
  async verifyFile(path: string): Promise<FileOwnership> {
    this.touch();
    return coreVerifyFile(this.root, path, this.agent);
  }

  /**
   * Re-confirm a fact by id (task) or path (file claim). Resolves whichever
   * exists. Throws if neither matches.
   */
  async verify(idOrPath: string): Promise<Task | FileOwnership> {
    if (getTask(this.root, idOrPath)) return this.verifyTask(idOrPath);
    if (fileOwner(this.root, idOrPath)) return this.verifyFile(idOrPath);
    throw new Error(`No task or file claim matching "${idOrPath}".`);
  }

  /** The resolved project configuration (defaults if no config.json). */
  async getConfig(): Promise<StatedConfig> {
    return loadConfig(this.root);
  }

  /**
   * Run the customizable memory-decay policy. Dry run by default — pass
   * `{ apply: true }` to actually release stale locks / archive old tasks /
   * trim events. All policies are off unless enabled in `.stated/config.json`.
   */
  async decay(opts: { apply?: boolean } = {}): Promise<DecayReport> {
    return applyDecay(this.root, opts);
  }

  /** Reconcile claims against git reality. Proposes corrections only. */
  async sync(): Promise<SyncReport> {
    return syncProject(this.root, {
      ...(this.agent ? { actor: this.agent } : {}),
    });
  }

  // --- Search ----------------------------------------------------------------

  /**
   * Keyword-search tasks, decisions and goals with BM25 (no embeddings).
   * Returns ranked hits, highest score first.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const scoped: SearchOptions =
      this.run && opts.run === undefined ? { ...opts, run: this.run } : opts;
    return searchProject(this.root, query, scoped);
  }

  // --- Events ----------------------------------------------------------------

  async getEvents(): Promise<StatedEvent[]> {
    return readEvents(this.root);
  }
}

/** Convenience factory mirroring `new Stated(options)`. */
export function createStated(options?: StatedOptions): Stated {
  return new Stated(options);
}

export type { StatedOptions as StatedSdkOptions };
