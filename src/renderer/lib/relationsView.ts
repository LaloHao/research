import type { Citations, CitationsStatus } from '../../shared/relations'

export function citationsState(c: Citations | null): CitationsStatus {
  return !c ? 'none' : c.unresolved ? 'unresolved' : 'ok'
}

export function scorePercent(score: number): string {
  return `${Math.round(score * 100)} %`
}
