import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Persona — first contact',
  description: 'Meet the personal assistant you just named.'
}

export const viewport: Viewport = {
  themeColor: '#f3f0e8',
  viewportFit: 'cover'
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
