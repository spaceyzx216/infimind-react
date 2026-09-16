import React from 'react'
import { Link } from 'react-router-dom'
import { LayoutGrid } from 'lucide-react'
import './ToolOverviewLink.css'

export default function ToolOverviewLink() {
  return <Link className="tool-overview-link" to="/tools"><LayoutGrid size={17} /><span>工具总览</span></Link>
}
