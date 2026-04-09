import { Panel } from './Panel';

/** Task from Paperclip API */
interface PaperclipTask {
  id: string;
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'done';
  priority?: 'low' | 'medium' | 'high';
  project?: string;
  due_date?: string;
  created_at?: string;
  updated_at?: string;
}

type FilterStatus = 'all' | 'in_progress' | 'todo' | 'backlog' | 'done';

const PAPERCLIP_API = 'http://localhost:3100';
const PROJECT_CID = 'ffb6d113';
const REFRESH_INTERVAL_MS = 30_000;

const STATUS_LABEL: Record<string, string> = {
  in_progress: 'IN PROGRESS',
  todo: 'TODO',
  backlog: 'BACKLOG',
  done: 'DONE',
};

const STATUS_COLOR: Record<string, string> = {
  in_progress: 'var(--status-live)',
  todo: '#58A6FF',
  backlog: 'var(--text-dim)',
  done: 'var(--text-faint)',
};

const PRIORITY_COLOR: Record<string, string> = {
  high: 'var(--threat-critical)',
  medium: 'var(--threat-medium)',
  low: 'var(--threat-low)',
};

/**
 * PaperclipPanel — shows tasks from the local Paperclip API
 * following the worldmonitor panel aesthetic.
 */
export class PaperclipPanel extends Panel {
  private tasks: PaperclipTask[] = [];
  private filter: FilterStatus = 'all';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private tabEls: Map<FilterStatus, HTMLElement> = new Map();
  private listEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;

  constructor() {
    super({ id: 'paperclip', title: 'Paperclip Tasks', showCount: true });
    this.buildUI();
    this.fetchTasks();
    this.refreshTimer = setInterval(() => this.fetchTasks(), REFRESH_INTERVAL_MS);
  }

  destroy(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
  }

  private buildUI(): void {
    this.content.innerHTML = '';
    this.content.style.padding = '0';

    // ── Tabs bar ──────────────────────────────────
    const tabs = document.createElement('div');
    tabs.className = 'panel-tabs';

    const filterOptions: FilterStatus[] = ['all', 'in_progress', 'todo', 'backlog', 'done'];
    const tabLabels: Record<FilterStatus, string> = {
      all: 'All',
      in_progress: 'Active',
      todo: 'Todo',
      backlog: 'Backlog',
      done: 'Done',
    };

    for (const f of filterOptions) {
      const tab = document.createElement('button');
      tab.className = `panel-tab${f === this.filter ? ' active' : ''}`;
      tab.innerHTML = `<span class="tab-label">${tabLabels[f]}</span>`;
      tab.addEventListener('click', () => this.setFilter(f));
      tabs.appendChild(tab);
      this.tabEls.set(f, tab);
    }

    // ── Error banner ──────────────────────────────
    const error = document.createElement('div');
    error.style.cssText = `
      display: none;
      padding: 12px;
      font-size: 11px;
      color: var(--semantic-critical);
      background: rgba(255,68,68,0.08);
      border-bottom: 1px solid rgba(255,68,68,0.2);
    `;
    this.errorEl = error;

    // ── Task list ─────────────────────────────────
    const list = document.createElement('div');
    list.style.cssText = 'padding: 8px; display: flex; flex-direction: column; gap: 4px;';
    this.listEl = list;

    this.content.appendChild(tabs);
    this.content.appendChild(error);
    this.content.appendChild(list);
  }

  private setFilter(f: FilterStatus): void {
    this.filter = f;
    for (const [key, el] of this.tabEls) {
      el.classList.toggle('active', key === f);
    }
    this.renderList();
  }

  private async fetchTasks(): Promise<void> {
    try {
      const res = await fetch(`${PAPERCLIP_API}/api/tasks?projectId=${PROJECT_CID}`, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      // Support both { tasks: [] } and [] response shapes
      this.tasks = Array.isArray(data) ? data : (data.tasks ?? data.data ?? []);

      if (this.errorEl) this.errorEl.style.display = 'none';
      this.renderList();
      this.updateCount(this.tasks.filter(t => t.status === 'in_progress').length);
    } catch (err) {
      if (this.errorEl) {
        this.errorEl.style.display = 'block';
        this.errorEl.textContent = `⚠ Paperclip unavailable — ${err instanceof Error ? err.message : 'connection failed'}`;
      }
    }
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';

    const filtered = this.filter === 'all'
      ? this.tasks
      : this.tasks.filter(t => t.status === this.filter);

    // Sort: in_progress first, then by priority (high → medium → low), then alphabetical
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const statusOrder: Record<string, number> = { in_progress: 0, todo: 1, backlog: 2, done: 3 };
    filtered.sort((a, b) => {
      const sd = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
      if (sd !== 0) return sd;
      const pd = (priorityOrder[a.priority ?? 'low'] ?? 2) - (priorityOrder[b.priority ?? 'low'] ?? 2);
      if (pd !== 0) return pd;
      return a.title.localeCompare(b.title);
    });

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding: 24px 12px; text-align: center; color: var(--text-dim); font-size: 12px;';
      empty.textContent = this.filter === 'all' ? 'No tasks found' : `No ${this.filter} tasks`;
      this.listEl.appendChild(empty);
      return;
    }

    for (const task of filtered) {
      this.listEl.appendChild(this.renderTaskRow(task));
    }
  }

  private renderTaskRow(task: PaperclipTask): HTMLElement {
    const isActive = task.status === 'in_progress';
    const isDone = task.status === 'done';
    const statusColor = STATUS_COLOR[task.status] ?? 'var(--text-dim)';
    const accentBorder = isActive ? statusColor : 'transparent';

    const row = document.createElement('div');
    row.style.cssText = `
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 9px 10px;
      background: var(--surface);
      border-radius: 6px;
      border-left: 3px solid ${accentBorder};
      transition: background 0.12s ease;
      cursor: default;
    `;

    row.addEventListener('mouseenter', () => {
      row.style.background = 'var(--surface-hover)';
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = 'var(--surface)';
    });

    // Dot indicator
    const dot = document.createElement('div');
    dot.style.cssText = `
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: ${statusColor};
      flex-shrink: 0;
      margin-top: 4px;
      ${isActive ? `box-shadow: 0 0 6px ${statusColor};` : ''}
    `;

    // Content
    const content = document.createElement('div');
    content.style.cssText = 'flex: 1; min-width: 0;';

    const title = document.createElement('div');
    title.style.cssText = `
      font-size: 12px;
      color: ${isDone ? 'var(--text-dim)' : 'var(--text)'};
      font-weight: ${isActive ? '500' : '400'};
      text-decoration: ${isDone ? 'line-through' : 'none'};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    `;
    title.textContent = task.title;

    const meta = document.createElement('div');
    meta.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
    `;

    // Status badge
    const statusBadge = document.createElement('span');
    statusBadge.style.cssText = `
      font-family: var(--font-mono);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: ${statusColor};
    `;
    statusBadge.textContent = STATUS_LABEL[task.status] ?? task.status.toUpperCase();

    // Project tag
    if (task.project) {
      const proj = document.createElement('span');
      proj.style.cssText = `
        font-size: 9px;
        color: var(--text-muted);
        font-family: var(--font-mono);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100px;
      `;
      proj.textContent = `· ${task.project}`;
      meta.appendChild(statusBadge);
      meta.appendChild(proj);
    } else {
      meta.appendChild(statusBadge);
    }

    content.appendChild(title);
    content.appendChild(meta);

    // Right side: priority badge
    const right = document.createElement('div');
    right.style.cssText = 'display: flex; flex-direction: column; align-items: flex-end; flex-shrink: 0; gap: 4px;';

    if (task.priority && task.priority !== 'low') {
      const prio = document.createElement('span');
      const prioColor = PRIORITY_COLOR[task.priority] ?? 'var(--text-dim)';
      prio.style.cssText = `
        font-family: var(--font-mono);
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.06em;
        color: ${prioColor};
        background: color-mix(in srgb, ${prioColor} 10%, transparent);
        border: 1px solid color-mix(in srgb, ${prioColor} 20%, transparent);
        border-radius: 3px;
        padding: 1px 5px;
      `;
      prio.textContent = task.priority.toUpperCase();
      right.appendChild(prio);
    }

    row.appendChild(dot);
    row.appendChild(content);
    if (right.children.length > 0) row.appendChild(right);

    return row;
  }

  /** Update the count badge in the panel header */
  private updateCount(n: number): void {
    const countEl = this.element.querySelector('.panel-count') as HTMLElement | null;
    if (countEl) {
      countEl.textContent = String(n);
      countEl.style.display = n > 0 ? '' : 'none';
    }
  }
}
