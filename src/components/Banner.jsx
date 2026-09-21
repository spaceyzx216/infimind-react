import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion, useScroll, useTransform } from 'framer-motion'
import './Banner.css'

const Banner = () => {
  const [currentSlide, setCurrentSlide] = useState(0)
  const [logoError, setLogoError] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [meihuaImageError, setMeihuaImageError] = useState(false)
  const [tongchengImageError, setTongchengImageError] = useState(false)
  
  // 图片和文字容器的 ref
  const meihuaImageRef = useRef(null)
  const meihuaTextRef = useRef(null)
  const tongchengImageRef = useRef(null)
  const tongchengTextRef = useRef(null)
  const xinhuaImageRef = useRef(null)
  const xinhuaTextRef = useRef(null)
  const logoPath = '/logo.webp'
  const imagePath = '/新华网.webp'
  const meihuaImagePath = '/梅花创投.webp'
  const tongchengImagePath = '/58同城.webp'
  const totalSlides = 3

  // 响应式检测
  const [isMobile, setIsMobile] = useState(false)
  const [scrollRange, setScrollRange] = useState(600)

  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth <= 768
      setIsMobile(mobile)
      // 移动端使用视口高度的倍数作为滚动范围，桌面端使用固定值
      setScrollRange(mobile ? window.innerHeight * 0.8 : 600)
    }

    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // 滚动动画
  const { scrollY } = useScroll()
  
  // Video animations - 响应式滚动范围
  const videoScale = useTransform(scrollY, [0, scrollRange], [1, 0.9])
  const videoOpacity = useTransform(scrollY, [0, scrollRange], [1, 0])
  const videoBlur = useTransform(scrollY, [0, scrollRange], ["blur(0px)", "blur(10px)"])
  
  // 当滚动超过范围时，Banner完全隐藏且不阻挡交互
  const bannerVisibility = useTransform(
    scrollY, 
    [0, scrollRange, scrollRange + 1], 
    ["visible", "visible", "hidden"]
  )
  // 保持交互性，只在完全隐藏时才禁用
  const bannerPointerEvents = useTransform(
    scrollY, 
    [0, scrollRange, scrollRange + 1], 
    ["auto", "auto", "none"]
  )

  // 自动轮播
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % totalSlides)
    }, 5000) // 每5秒切换一次

    return () => clearInterval(timer)
  }, [totalSlides])

  // 同步图片和文字容器的宽度和位置（高度由内容自适应，使用百分比）
  const syncTextWidth = useCallback((imageRef, textRef) => {
    if (imageRef.current && textRef.current) {
      const image = imageRef.current
      const text = textRef.current
      const wrapper = image.parentElement
      
      if (!wrapper) return
      
      const imageRect = image.getBoundingClientRect()
      const wrapperRect = wrapper.getBoundingClientRect()
      
      if (imageRect.width > 0 && imageRect.height > 0) {
        // 计算图片相对于 wrapper 的位置百分比
        const leftPercent = ((imageRect.left - wrapperRect.left) / wrapperRect.width) * 100
        const imageWidthPercent = (imageRect.width / wrapperRect.width) * 100
        
        // 计算图片底部相对于 wrapper 的位置百分比
        const topPercent = ((imageRect.top - wrapperRect.top) / wrapperRect.height) * 100
        const imageHeightPercent = (imageRect.height / wrapperRect.height) * 100
        const bottomPercent = 100 - (topPercent + imageHeightPercent)
        
        // 使用百分比设置文字容器的宽度和位置
        text.style.width = `${imageWidthPercent}%`
        text.style.height = 'auto'
        text.style.top = 'auto'
        text.style.bottom = `${Math.max(0, bottomPercent)}%`
        text.style.left = `${leftPercent + imageWidthPercent / 2}%`
        text.style.transform = 'translateX(-50%)'
      }
    }
  }, [])

  useEffect(() => {
    const updateTextWidths = () => {
      syncTextWidth(meihuaImageRef, meihuaTextRef)
      syncTextWidth(tongchengImageRef, tongchengTextRef)
      syncTextWidth(xinhuaImageRef, xinhuaTextRef)
    }

    // 防抖函数
    let resizeTimer = null
    const handleResize = () => {
      if (resizeTimer) {
        clearTimeout(resizeTimer)
      }
      resizeTimer = setTimeout(() => {
        updateTextWidths()
      }, 150)
    }

    // 初始更新
    updateTextWidths()

    // 监听窗口大小变化
    window.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleResize)

    // 延迟更新以确保图片已加载
    const timer = setTimeout(updateTextWidths, 100)
    const timer2 = setTimeout(updateTextWidths, 500) // 额外延迟确保完全加载

    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('orientationchange', handleResize)
      if (resizeTimer) clearTimeout(resizeTimer)
      clearTimeout(timer)
      clearTimeout(timer2)
    }
  }, [currentSlide, syncTextWidth])

  const goToSlide = (index) => {
    setCurrentSlide(index)
  }

  return (
    <motion.section 
      id="home" 
      className="banner-section"
      style={{ 
        scale: videoScale, 
        opacity: videoOpacity,
        filter: videoBlur,
        visibility: bannerVisibility,
        pointerEvents: bannerPointerEvents
      }}
    >
      <div className="banner-container">
        {/* 左半边：轮播图区域 */}
        <div className="banner-left">
          <div className="banner-slider-wrapper">
            <div 
              className="banner-slider-track"
              style={{ transform: `translateX(-${currentSlide * (100 / totalSlides)}%)` }}
            >
              {/* 第三页：梅花创投图片 */}
              <div className="banner-slide">
                <div className="banner-image-slide">
                  {/* 图片容器 */}
                  <div className="banner-image-wrapper">
                    {!meihuaImageError ? (
                      <img 
                        ref={meihuaImageRef}
                        src={meihuaImagePath} 
                        alt="梅花创投"
                        className="banner-slide-image"
                        onError={() => setMeihuaImageError(true)}
                        onLoad={() => syncTextWidth(meihuaImageRef, meihuaTextRef)}
                        loading="eager"
                        fetchpriority="high"
                      />
                    ) : (
                      <div className="banner-image-placeholder">
                        <p>图片加载失败</p>
                        <p style={{ fontSize: '0.9rem', color: '#999', marginTop: '0.5rem' }}>
                          请确保图片文件位于 public/梅花创投.webp
                        </p>
                      </div>
                    )}
                    {/* 覆盖在图片上的文字 */}
                    <div ref={meihuaTextRef} className="banner-image-text">
                      <h3 className="banner-image-title">创始人夏孙明先生与知名投资人吴世春举行"巅峰对话"</h3>
                    </div>
                  </div>
                </div>
              </div>

              {/* 第四页：58同城图片 */}
              <div className="banner-slide">
                <div className="banner-image-slide">
                  {/* 图片容器 */}
                  <div className="banner-image-wrapper">
                    {!tongchengImageError ? (
                      <img 
                        ref={tongchengImageRef}
                        src={tongchengImagePath} 
                        alt="58同城"
                        className="banner-slide-image"
                        onError={() => setTongchengImageError(true)}
                        onLoad={() => syncTextWidth(tongchengImageRef, tongchengTextRef)}
                        loading="eager"
                        fetchpriority="high"
                      />
                    ) : (
                      <div className="banner-image-placeholder">
                        <p>图片加载失败</p>
                        <p style={{ fontSize: '0.9rem', color: '#999', marginTop: '0.5rem' }}>
                          请确保图片文件位于 public/58同城.webp
                        </p>
                      </div>
                    )}
                    {/* 覆盖在图片上的文字 */}
                    <div ref={tongchengTextRef} className="banner-image-text">
                      <h3 className="banner-image-title">创始人夏孙明参与新华网新生代雇主大会</h3>
                    </div>
                  </div>
                </div>
              </div>
              
              {/* 第二页：新华网图片 */}
              <div className="banner-slide">
                <div className="banner-image-slide">
                  {/* 图片容器 */}
                  <div className="banner-image-wrapper">
                    {!imageError ? (
                      <img 
                        ref={xinhuaImageRef}
                        src={imagePath} 
                        alt="法飞飞AI与科大讯飞合作"
                        className="banner-slide-image"
                        onError={() => setImageError(true)}
                        onLoad={() => syncTextWidth(xinhuaImageRef, xinhuaTextRef)}
                        loading="eager"
                        fetchpriority="high"
                      />
                    ) : (
                      <div className="banner-image-placeholder">
                        <p>图片加载失败</p>
                        <p style={{ fontSize: '0.9rem', color: '#999', marginTop: '0.5rem' }}>
                          请确保图片文件位于 public/新华网.webp
                        </p>
                      </div>
                    )}
                    {/* 覆盖在图片上的文字 */}
                    <div ref={xinhuaTextRef} className="banner-image-text">
                      <h3 className="banner-image-title">新华网报道，我司获科大讯飞战略投资</h3>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            {/* 轮播指示器 */}
            <div className="slider-indicators">
              {Array.from({ length: totalSlides }).map((_, index) => (
                <button
                  key={index}
                  className={`slider-indicator ${currentSlide === index ? 'active' : ''}`}
                  onClick={() => goToSlide(index)}
                  aria-label={`Go to slide ${index + 1}`}
                />
              ))}
            </div>
          </div>
        </div>
        
        {/* 右半边：Logo和文本内容 */}
        <div className="banner-right">
          {/* 上边：法飞飞AI Logo */}
          <div className="banner-logo">
            {!logoError ? (
              <img 
                src={logoPath} 
                alt="法飞飞AI Logo" 
                className="banner-logo-img"
                onError={() => setLogoError(true)}
                loading="eager"
                fetchpriority="high"
              />
            ) : (
              <div className="banner-logo-placeholder">法飞飞AI Logo</div>
            )}
          </div>
          
          {/* 下边：标题、描述和按钮 */}
          <div className="banner-text" style={{ pointerEvents: 'auto', position: 'relative', zIndex: 10 }}>
            <h1 className="banner-title">任何用工风险一键咨询，您身边的及时用工风险专家</h1>
            <p className="banner-desc">基于海量数据库智能体和人工交付完美解决您的一切用工问题</p>
            <a 
              className="primary-btn" 
              href="https://jsj.top/f/NctQWw" 
              target="_blank" 
              rel="noopener noreferrer"
              style={{ 
                pointerEvents: 'auto', 
                position: 'relative', 
                zIndex: 20,
                cursor: 'pointer'
              }}
              onClick={(e) => {
                e.stopPropagation();
                window.open('https://jsj.top/f/NctQWw', '_blank', 'noopener,noreferrer');
              }}
            >
              了解详情
            </a>
          </div>
        </div>
      </div>
    </motion.section>
  )
}

export default Banner
