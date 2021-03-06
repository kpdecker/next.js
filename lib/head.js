import React from 'react'
import sideEffect from './side-effect'
import { updateHead } from './head-manager'

class Head extends React.Component {
  render () {
    return null
  }
}

export const defaultHead = [<meta charSet='utf-8' className='next-head' />]

function reduceComponents (components) {
  return components
    .map((c) => c.props.children)
    .map((children) => React.Children.toArray(children))
    .reduce((a, b) => a.concat(b), [])
    .reverse()
    .concat(defaultHead)
    .filter(Boolean)
    .filter(unique())
    .reverse()
    .map((c) => {
      const className = (c.className ? c.className + ' ' : '') + 'next-head'
      return React.cloneElement(c, { className })
    })
}

const METATYPES = ['name', 'httpEquiv', 'charSet', 'itemProp', 'property']

// returns a function for filtering head child elements
// which shouldn't be duplicated, like <title/>.

function unique () {
  const tags = {}

  return (h) => {
    switch (h.type) {
      case 'title':
      case 'base':
        if (tags[h.type]) return false
        tags[h.type] = true
        break
      case 'meta':
        for (let i = 0, len = METATYPES.length; i < len; i++) {
          const metatype = METATYPES[i]
          if (!h.props.hasOwnProperty(metatype)) continue

          if (metatype === 'charSet') {
            if (tags[metatype]) return false
            tags[metatype] = true
          } else {
            const category = h.props[metatype]
            const key = `${metatype}_${category}`
            if (tags[key]) return false
            tags[key] = true
          }
        }
        break
    }
    return true
  }
}

export default sideEffect(reduceComponents, updateHead)(Head)
