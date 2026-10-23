import { createContext, useContext } from 'react'

export const TourContext = createContext<{ start: () => void }>({ start: () => undefined })
export function useTour() {
  return useContext(TourContext)
}
