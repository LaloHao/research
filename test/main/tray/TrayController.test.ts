import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { TrayController, type TraySnapshot } from '../../../src/main/tray/TrayController'
import type { TrayActionId } from '../../../src/main/tray/trayModel'

class FakeTray {
  images: unknown[] = []
  tooltip = ''
  menu: MenuItemConstructorOptions[] = []
  destroyed = false
  private click: (() => void) | null = null
  constructor(image: unknown) {
    this.images.push(image)
  }
  setImage(image: unknown): void {
    this.images.push(image)
  }
  setToolTip(text: string): void {
    this.tooltip = text
  }
  setContextMenu(menu: unknown): void {
    this.menu = menu as MenuItemConstructorOptions[]
  }
  on(_event: 'click', listener: () => void): void {
    this.click = listener
  }
  leftClick(): void {
    this.click?.()
  }
  destroy(): void {
    this.destroyed = true
  }
}

const snapshot = (over: Partial<TraySnapshot> = {}): TraySnapshot => ({
  windowVisible: true,
  looking: false,
  projectRoot: '/home/me/thesis',
  projectName: 'Tesis',
  sync: null,
  conflicts: 0,
  jobsActive: 0,
  failedJobIds: [],
  apiEnabled: true,
  ...over
})

function setup(fail = false): { controller: TrayController; tray: () => FakeTray; acts: TrayActionId[]; snap: { current: TraySnapshot } } {
  let tray: FakeTray | null = null
  const acts: TrayActionId[] = []
  const snap = { current: snapshot() }
  const controller = new TrayController({
    createTray: (image) => {
      if (fail) throw new Error('no tray')
      tray = new FakeTray(image)
      return tray
    },
    buildMenu: (template) => template,
    icon: (variant) => `icon:${variant}`,
    snapshot: async () => snap.current,
    act: (id) => acts.push(id),
    debounceMs: 0
  })
  return { controller, tray: () => tray!, acts, snap }
}

describe('tray controller', () => {
  it('is unavailable until the icon exists, and for good when it cannot be created', () => {
    const ok = setup()
    expect(ok.controller.available()).toBe(false)
    expect(ok.controller.create()).toBe(true)
    expect(ok.controller.available()).toBe(true)
    const failing = setup(true)
    expect(failing.controller.create()).toBe(false)
    expect(failing.controller.available()).toBe(false)
  })

  it('toggles the window on a left click and runs the menu items', async () => {
    const { controller, tray, acts } = setup()
    controller.create()
    await controller.render()
    tray().leftClick()
    const quit = tray().menu.find((item) => item.label === 'Salir')
    quit?.click?.({} as never, undefined, {} as never)
    expect(acts).toEqual(['toggle-window', 'quit'])
    expect(tray().menu.find((item) => item.type === 'checkbox')).toMatchObject({ label: 'API local: encendida', checked: true })
  })

  it('switches the icon and the tooltip with the state', async () => {
    const { controller, tray, snap } = setup()
    controller.create()
    await controller.render()
    expect(tray().images).toEqual(['icon:normal'])
    snap.current = snapshot({ jobsActive: 2 })
    await controller.render()
    expect(tray().images.at(-1)).toBe('icon:busy')
    expect(tray().tooltip).toContain('2 trabajos en curso')
    // A job failed while nobody looked: attention until the window is looked at.
    snap.current = snapshot({ failedJobIds: [9] })
    await controller.render()
    expect(tray().images.at(-1)).toBe('icon:attention')
    snap.current = snapshot({ failedJobIds: [9], looking: true })
    await controller.render()
    expect(tray().images.at(-1)).toBe('icon:normal')
  })

  it('does not count another project’s old failures', async () => {
    const { controller, tray, snap } = setup()
    controller.create()
    await controller.render()
    snap.current = snapshot({ projectRoot: '/other', failedJobIds: [1, 2] })
    await controller.render()
    expect(tray().images.at(-1)).toBe('icon:normal')
  })

  it('keeps a message in the tooltip for a moment', async () => {
    const { controller, tray } = setup()
    controller.create()
    controller.say('El portapapeles no tiene un DOI, arXiv o URL', 60_000)
    await controller.render()
    expect(tray().tooltip).toBe('El portapapeles no tiene un DOI, arXiv o URL')
    controller.destroy()
    expect(tray().destroyed).toBe(true)
    expect(controller.available()).toBe(false)
  })
})
