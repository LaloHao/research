import { useCallback, useEffect, useRef, useState } from 'react'
import type { LlmModel } from '../../shared/summary'
import { useEvent } from './useEvent'

/** The project's model (Ajustes → Claude): the model of a new conversation. Sonnet until it loads, or if it cannot. */
export function useProjectModel(): LlmModel {
  const [model, setModel] = useState<LlmModel>('sonnet')
  const seq = useRef(0)
  const load = useCallback(() => {
    const token = ++seq.current
    window.research.llm.info().then(
      (info) => {
        if (token === seq.current) setModel(info.config.model)
      },
      () => undefined
    )
  }, [])
  useEffect(load, [load])
  useEvent('project-changed', load)
  return model
}
