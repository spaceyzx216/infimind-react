import { Navigate, useParams } from 'react-router-dom'
import { useAuth } from '../components/AuthProvider'
import PensionCalculatorContent from './PensionCalculatorContent'
import './PensionCalculationPage.css'

export default function PensionCalculationPage({ toolId: explicitToolId }) {
  const params = useParams()
  const { user } = useAuth()
  const toolId = explicitToolId ?? params.toolId
  if (!['pension-calc1', 'pension-calc2'].includes(toolId)) return <Navigate to="/tools" replace />
  if (!user) return null
  return <main className="pension-calculation-page">
    <header className="pension-page-header"><h1>养老保险测算</h1></header>
    <PensionCalculatorContent key={`${user.id}:${toolId}`} initialToolId={toolId} />
  </main>
}
