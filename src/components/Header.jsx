import React, { useState, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { 
  Brain, 
  FileText, 
  Scale, 
  BookOpen, 
  Calculator, 
  Building2, 
  User,
  FileEdit,
  FilePenLine
} from 'lucide-react'
import './Header.css'

const Header = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [activeDropdown, setActiveDropdown] = useState(null)
  const [pendingScrollTarget, setPendingScrollTarget] = useState(null)
  const [shouldScrollToTop, setShouldScrollToTop] = useState(false)

  const toggleMobileMenu = () => {
    setIsMobileMenuOpen(!isMobileMenuOpen)
  }

  const handleDropdownEnter = (dropdown) => {
    setActiveDropdown(dropdown)
  }

  const handleDropdownLeave = () => {
    setActiveDropdown(null)
  }

  const scrollToSection = (targetId) => {
    // 使用重试机制，确保元素已加载
    let attempts = 0
    const maxAttempts = 10
    
    const tryScroll = () => {
    const element = document.getElementById(targetId)
    if (element) {
      const headerHeight = document.getElementById('header')?.offsetHeight || 0
      const elementPosition = element.getBoundingClientRect().top + window.pageYOffset
      const offsetPosition = elementPosition - headerHeight

      window.scrollTo({
        top: offsetPosition,
        behavior: 'smooth'
      })
        return true
      }
      return false
    }

    // 立即尝试一次
    if (!tryScroll()) {
      // 如果失败，使用requestAnimationFrame重试
      const retry = () => {
        attempts++
        if (attempts < maxAttempts) {
          if (!tryScroll()) {
            requestAnimationFrame(retry)
          }
        }
      }
      requestAnimationFrame(retry)
    }
  }

  const handleNavClick = (e, targetId) => {
    e.preventDefault()
    setIsMobileMenuOpen(false) // 关闭移动端菜单
    
    // 如果不在首页，跳转到首页并直接定位到目标section
    if (location.pathname !== '/') {
      navigate(`/#${targetId}`)
      // 立即设置待滚动目标，确保定位
      setPendingScrollTarget(targetId)
    } else {
      scrollToSection(targetId)
    }
  }

  const handleAboutClick = (e) => {
    e.preventDefault()
    setIsMobileMenuOpen(false)
    
    // 如果在首页，跳转到关于页面
    if (location.pathname === '/') {
      // 先滚动到顶部，然后跳转
      window.scrollTo({
        top: 0,
        behavior: 'instant'
      })
      setShouldScrollToTop(true)
      // 清除URL中的hash，确保跳转到顶部
      navigate('/aboutus', { replace: true })
    } else {
      // 如果已经在关于页面，直接滚动到顶部
      window.scrollTo({
        top: 0,
        behavior: 'instant'
      })
    }
  }

  // 监听路径变化，当跳转到关于页面后滚动到顶部
  useEffect(() => {
    if (location.pathname === '/aboutus' && shouldScrollToTop) {
      // 立即滚动到顶部
      window.scrollTo({
        top: 0,
        behavior: 'instant'
      })
      
      // 使用多个延迟确保页面完全加载后再次滚动到顶部
      const scrollToTop = () => {
        window.scrollTo({
          top: 0,
          behavior: 'instant'
        })
      }
      
      // 立即执行
      scrollToTop()
      
      // 使用多个延迟时间确保页面完全加载
      const delays = [0, 50, 100, 200, 300]
      delays.forEach(delay => {
        setTimeout(scrollToTop, delay)
      })
      
      // 使用requestAnimationFrame确保DOM已更新
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToTop()
          setShouldScrollToTop(false)
        })
      })
    }
  }, [location.pathname, shouldScrollToTop])

  // 监听路径变化，当跳转到首页后立即执行滚动
  useEffect(() => {
    if (location.pathname === '/' && pendingScrollTarget) {
      const targetId = pendingScrollTarget
      
      // 立即尝试滚动，使用requestAnimationFrame确保DOM已更新
      const performScroll = (target) => {
        const element = document.getElementById(target)
        if (element) {
          const headerHeight = document.getElementById('header')?.offsetHeight || 0
          const elementPosition = element.getBoundingClientRect().top + window.pageYOffset
          const offsetPosition = elementPosition - headerHeight

          window.scrollTo({
            top: offsetPosition,
            behavior: 'instant' // 使用instant实现直接跳转
          })
          setPendingScrollTarget(null)
          return true
        }
        return false
      }

      // 使用requestAnimationFrame立即尝试，不等待延迟
      let attempts = 0
      const maxAttempts = 30 // 增加尝试次数以确保找到元素
      
      const tryScroll = () => {
        attempts++
        if (performScroll(targetId)) {
          return // 成功则停止
        }
        if (attempts < maxAttempts) {
          requestAnimationFrame(tryScroll)
        } else {
          // 如果所有尝试都失败，清除状态
          setPendingScrollTarget(null)
        }
      }

      // 立即开始尝试
      requestAnimationFrame(tryScroll)
    }
  }, [location.pathname, pendingScrollTarget])

  // 监听URL hash变化，直接定位到对应section
  useEffect(() => {
    const hash = window.location.hash.slice(1) // 移除#号
    if (hash && location.pathname === '/') {
      // 如果URL中有hash，直接定位
      const element = document.getElementById(hash)
      if (element) {
        const headerHeight = document.getElementById('header')?.offsetHeight || 0
        const elementPosition = element.getBoundingClientRect().top + window.pageYOffset
        const offsetPosition = elementPosition - headerHeight

        window.scrollTo({
          top: offsetPosition,
          behavior: 'instant'
        })
      }
    }
  }, [location.pathname, location.hash])

  const productItems = [
    { icon: Brain, text: '法飞飞AI-用工风险专家' },
    { icon: FileText, text: '劳动合同分析' },
    { icon: Scale, text: '劳动仲裁答辩' },
    { icon: BookOpen, text: '员工手册诊断' },
    { icon: Calculator, text: '医疗期计算器' },
    { icon: Building2, text: '企业职工养老保险测算' },
    { icon: User, text: '个体工商户或灵活就业者养老保险测算' },
  ]

  const contractRewriteItems = [
    { icon: FileEdit, text: '商业合同审查与批注', to: '/contract-rewrite' },
    { icon: FilePenLine, text: '商业合同智能起草', to: '/contract-draft' }
  ]

  // 用工风险是品牌主线，与商业合同工具并列作为独立入口分组
  const laborConsultItems = [
    { icon: Scale, text: '用工咨询', to: '/labor-consult' }
  ]

  return (
    <header className="header" id="header">
      <div className="navbar">
        <div className="navbar-container">
          <Link className="navbar-logo" to="/" aria-label="Home">
            <span className="logo-text">
              <img src="/法飞飞标题.webp" alt="法飞飞AI" className="logo-main-image" />
              <span className="logo-sub">
                <img src="/科大讯飞.webp" alt="科大讯飞" className="logo-company-image" />
                <span className="logo-sub-text">战略投资企业</span>
              </span>
            </span>
          </Link>
          
          <nav className={`navbar-nav ${isMobileMenuOpen ? 'active' : ''}`}>
            <ul className="nav-list">
              <li className="nav-item">
                <Link 
                  className={`nav-link ${location.pathname === '/' ? 'active' : ''}`} 
                  to="/"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  首页
                </Link>
              </li>
              <li 
                className="nav-item dropdown"
                onMouseEnter={() => handleDropdownEnter('products')}
                onMouseLeave={handleDropdownLeave}
              >
                <a className="nav-link" href="#products" onClick={(e) => handleNavClick(e, 'products')}>产品介绍</a>
                <div className={`dropdown-menu ${activeDropdown === 'products' ? 'show' : ''}`}>
                  <div className="dropdown-section">
                    <h4>法飞飞AI功能预览</h4>
                    <div className="product-list">
                      {productItems.map((item, index) => {
                        const IconComponent = item.icon
                        return (
                          <a 
                            key={index} 
                            href="#products" 
                            className="product-item"
                            onClick={(e) => handleNavClick(e, 'products')}
                          >
                            <div className="product-icon">
                              <IconComponent size={20} />
                            </div>
                            <span>{item.text}</span>
                          </a>
                        )
                      })}
                    </div>
                  </div>
                  <div className="dropdown-section">
                    <h4>商业合同工具</h4>
                    <div className="product-list">
                      {contractRewriteItems.map((item, index) => {
                        const IconComponent = item.icon
                        return (
                          <Link
                            key={index}
                            to={item.to}
                            className="product-item"
                            reloadDocument
                            onClick={() => {
                              setIsMobileMenuOpen(false)
                              setActiveDropdown(null)
                            }}
                          >
                            <div className="product-icon">
                              <IconComponent size={20} />
                            </div>
                            <span>{item.text}</span>
                          </Link>
                        )
                      })}
                    </div>
                  </div>
                  <div className="dropdown-section">
                    <h4>劳动用工工具</h4>
                    <div className="product-list">
                      {laborConsultItems.map((item, index) => {
                        const IconComponent = item.icon
                        return (
                          <Link
                            key={index}
                            to={item.to}
                            className="product-item"
                            reloadDocument
                            onClick={() => {
                              setIsMobileMenuOpen(false)
                              setActiveDropdown(null)
                            }}
                          >
                            <div className="product-icon">
                              <IconComponent size={20} />
                            </div>
                            <span>{item.text}</span>
                          </Link>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </li>
              <li className="nav-item">
                <a className="nav-link" href="#products" onClick={(e) => handleNavClick(e, 'products')}>商业合同模板库</a>
              </li>
              <li className="nav-item">
                <a className="nav-link" href="#solutions" onClick={(e) => handleNavClick(e, 'solutions')}>行业服务案例</a>
              </li>
              <li className="nav-item">
                <a 
                  className={`nav-link ${location.pathname === '/aboutus' ? 'active' : ''}`} 
                  href="/aboutus"
                  onClick={handleAboutClick}
                >
                  关于法飞飞AI
                </a>
              </li>
              <li className="nav-item">
                <a className="nav-link" href="#clients" onClick={(e) => handleNavClick(e, 'clients')}>客户案例</a>
              </li>
            </ul>
          </nav>
          
          <div className="navbar-right">
            <a className="primary-btn" href="https://jsj.top/f/NctQWw" target="_blank" rel="noopener noreferrer">免费咨询</a>
          </div>
          
          <div 
            className={`mobile-menu-btn ${isMobileMenuOpen ? 'active' : ''}`}
            onClick={toggleMobileMenu}
          >
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      </div>
    </header>
  )
}

export default Header
