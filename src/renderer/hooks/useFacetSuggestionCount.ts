import { useCallback, useEffect, useRef, useState } from 'react'
import { useEvent } from './useEvent'

/** Suggestions waiting for review, for the «Formulario (N)» tab; 0 when they cannot be read. */
export function useFacetSuggestionCount(): number {
  const [count, setCount] = useState(0)
  const request = useRef(0)
  const load = useCallback(() => {
    const token = ++request.current
    window.research.facets.list().then(
      (list) => {
        if (token === request.current) setCount(list.pending)
      },
      () => {
        if (token === request.current) setCount(0)
      }
    )
  }, [])
  useEffect(load, [load])
  useEvent('facets-changed', load)
  useEvent('project-changed', load)
  return count
}
