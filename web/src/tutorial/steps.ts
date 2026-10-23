// REQ_FE_128/131: the guided tour as data. Each step names the page it needs (`route`; no route = stay where the
// previous step left off), the element to highlight (`target`, a CSS selector), and its card text. `needsEdit` steps are
// only for logged-in people; `anonymousOnly` is the closing step for everyone else. `select` means the tour first
// selects the first deliverable (a click, which only opens the side panel and never writes, REQ_FE_132).
// `before` may add something temporary to the page and return (possibly as a promise) the function that removes it.
export type TourRoute = 'company' | 'team' | 'admin'

export interface TourStep {
  id: string
  route?: TourRoute
  target: string
  title: string
  body: string
  needsEdit?: boolean
  anonymousOnly?: boolean
  select?: boolean
  before?: () => void | (() => void) | Promise<void | (() => void)>
}

export const FIRST_BAR = '.deliverable[data-deliverable]:not(.dup)'

// REQ_FE_131: the connector dots exist only while the dependency arrows are on, and only show on hover. This turns the
// arrows on if they are off (a view switch, no roadmap data), and puts the class on one bar so its dots show without
// hovering; the CSS rule is in tutorial.css. A bar too short on screen has no dots, so the first bar that has them is used.
// The returned function undoes all of it.
const DOT_BAR = `${FIRST_BAR}:has(.cdot.r)`
async function showDots(): Promise<() => void> {
  const sw = document.querySelector<HTMLElement>('#sw-deps')
  const turnedOn = sw?.getAttribute('aria-checked') === 'false'
  if (turnedOn) sw.click()
  for (let i = 0; i < 40 && !document.querySelector(DOT_BAR); i++) await new Promise((r) => setTimeout(r, 50))
  const bar = document.querySelector(DOT_BAR)
  bar?.classList.add('tour-dots')
  return () => {
    bar?.classList.remove('tour-dots')
    if (turnedOn) sw.click()
  }
}

export const STEPS: TourStep[] = [
  { id: 'topbar', route: 'company', target: '[data-testid=topbar]', title: 'The top bar', body: 'Everything starts here: the two ways to look at the roadmaps, the help button, the light and dark theme and your account.' },
  { id: 'company-mode', target: '[data-testid=see-combined-roadmaps]', title: 'Company view', body: 'This opens every team together, grouped by workstream. It is the page you land on.' },
  { id: 'team-mode', target: '[data-testid=see-team-roadmaps]', title: 'Team roadmaps', body: 'This lists the teams. Pick one to see only that team\'s roadmap.' },
  { id: 'zoom', target: '#zoomseg', title: 'Zoom', body: 'Choose how much time fits on screen: a year, a half year, a quarter or a month.' },
  { id: 'range', target: '[data-testid=range]', title: 'Date range', body: 'The dates the timeline currently covers. It follows the roadmap items you have.' },
  { id: 'workstreams', target: '.ws-label', title: 'Workstreams', body: 'Each horizontal row is a workstream, a strand of work. Deliverables sit in the workstream they belong to, and several teams can contribute to one workstream.' },
  { id: 'deliverable', target: FIRST_BAR, title: 'Deliverables', body: 'A bar is a deliverable. Its length is its start and end date, and its colour and badge show its team and status.' },
  { id: 'milestone', target: '.ms[data-ms]', title: 'Milestones', body: 'A diamond is a milestone, a single date that matters. Its icon shows its status.' },
  { id: 'panel', select: true, target: '[data-testid=side-panel]', title: 'The side panel', body: 'Select a roadmap item and its details appear here: dates, status, workstreams, labels and description.' },
  { id: 'copies', target: '#sw-copies', title: 'Copies', body: 'A deliverable can belong to multiple workstreams (often the case for platform teams, for example). You can choose to see a deliverable in all its workstreams or only in one.' },
  { id: 'arrows', target: '#sw-deps', title: 'Dependency arrows', body: 'Turn this on to draw an arrow from each roadmap item to the ones that wait for it.' },
  { id: 'depends-on', select: true, target: '[data-testid=panel-depends-on]', title: 'Depends on', body: 'The roadmap items that must finish before this one can start.' },
  { id: 'blocks', select: true, target: '[data-testid=panel-blocks]', title: 'Blocks', body: 'The roadmap items that are waiting for this one.' },
  { id: 'trace-btn', route: 'company', select: true, target: '[data-testid=trace-btn]', title: 'Trace dependencies', body: 'With a roadmap item selected, this button follows its dependencies, all the way back and all the way forward.' },
  { id: 'trace-banner', route: 'company', select: true, target: '[data-testid=trace-banner]', title: 'The trace', body: 'Only the chain around the selected item is shown. "Show all roadmap items" brings the whole roadmap back.', before: () => { document.querySelector<HTMLElement>('[data-testid=trace-btn]')?.click() } },
  { id: 'milestones-only', route: 'company', target: '[data-testid=sw-milestones]', title: 'Milestones only', body: 'Show only the milestones of every team. Click a milestone to see everything that leads to it, with who owns each part and what needs attention; click it again to close.' },
  { id: 'csv', route: 'team', target: '[data-testid=download-csv]', title: 'CSV download', body: 'This downloads the team\'s roadmap as a CSV file for a spreadsheet. Anyone can use it.' },

  { id: 'add-deliverable', needsEdit: true, target: '[data-testid=add-deliverable]', title: 'Add a deliverable', body: 'Create a new deliverable. A form asks for its name, dates and workstreams, and nothing is saved until you press Create.' },
  { id: 'add-milestone', needsEdit: true, target: '[data-testid=add-milestone]', title: 'Add a milestone', body: 'Create a milestone on a single date.' },
  { id: 'add-workstream', needsEdit: true, target: '[data-testid=add-workstream]', title: 'Add a workstream', body: 'Add a new row to this team\'s roadmap.' },
  { id: 'drag', needsEdit: true, target: FIRST_BAR, title: 'Move and resize', body: 'Drag a bar to move it in time or to another workstream. Drag its left or right edge to change its start or end. Changes are saved as you let go.' },
  { id: 'dots', needsEdit: true, select: true, target: `${DOT_BAR} .cdot.r`, title: 'Connector dots', body: 'Hover a bar to see a dot at each end. Drag from a dot to another roadmap item to say one depends on the other.', before: showDots },
  { id: 'full-edit', needsEdit: true, select: true, target: '[aria-label="Open the full edit window"]', title: 'The full edit window', body: 'This opens every field of the deliverable in one window. Fields in the side panel save when you leave them.' },
  { id: 'delete', needsEdit: true, select: true, target: '[data-testid=panel-delete]', title: 'Delete', body: 'Deleting always asks you to confirm first, and a deleted item cannot be brought back.' },
  { id: 'account', needsEdit: true, target: '[data-testid=account-menu]', title: 'Your account', body: 'Open this menu to reach the Admin page or to log out.' },
  { id: 'admin-users', needsEdit: true, route: 'admin', target: '#admin-users', title: 'Users', body: 'Add people who may edit, reset passwords and remove accounts.' },
  { id: 'admin-teams', needsEdit: true, target: '#admin-teams', title: 'Teams', body: 'Create, rename and delete teams, and set their colours.' },
  { id: 'admin-icons', needsEdit: true, target: '#admin-icons', title: 'Icons', body: 'Choose the label shown with each icon on the roadmaps.' },
  { id: 'admin-audit', needsEdit: true, target: '#admin-audit', title: 'Audit log', body: 'A record of who changed what and when.' },

  { id: 'login', anonymousOnly: true, target: '[data-testid=login-button]', title: 'Log in to edit', body: 'Reading needs no account. Log in to add and change deliverables, milestones and workstreams.' },
]

// REQ_FE_131: what this person gets to see.
export function stepsFor(canEdit: boolean): TourStep[] {
  return STEPS.filter((s) => (canEdit ? !s.anonymousOnly : !s.needsEdit))
}
