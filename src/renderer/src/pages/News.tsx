import { useEffect, useState } from 'react'
import type { Post } from '@shared/types'

function formatDate(dateStr: string): string {
  try {
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    }).format(new Date(dateStr))
  } catch {
    return dateStr
  }
}

function SkeletonCard() {
  return (
    <div className="card p-5 flex flex-col gap-3 animate-pulse">
      <div className="w-full h-40 bg-bg-elevated rounded-lg" />
      <div className="h-5 bg-bg-elevated rounded w-3/4" />
      <div className="h-4 bg-bg-elevated rounded w-full" />
      <div className="h-4 bg-bg-elevated rounded w-2/3" />
      <div className="flex items-center justify-between mt-1">
        <div className="h-3 bg-bg-elevated rounded w-1/4" />
        <div className="h-8 bg-bg-elevated rounded w-24" />
      </div>
    </div>
  )
}

function PostCard({ post }: { post: Post }) {
  return (
    <article className="card-interactive flex flex-col overflow-hidden group">
      {post.image && (
        <div className="w-full h-40 overflow-hidden bg-bg-elevated flex-shrink-0">
          <img
            src={post.image}
            alt={post.title}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        </div>
      )}
      <div className="flex flex-col flex-1 p-5 gap-2">
        <h2 className="text-base font-semibold text-text-primary leading-snug group-hover:text-accent transition-colors duration-150 line-clamp-2">
          {post.title}
        </h2>
        {post.excerpt && (
          <p className="text-sm text-text-secondary line-clamp-3 flex-1">{post.excerpt}</p>
        )}
        <div className="flex items-center justify-between pt-2 mt-auto">
          {post.date ? (
            <time className="text-xs text-text-muted">{formatDate(post.date)}</time>
          ) : (
            <span />
          )}
          <button
            className="btn-secondary text-xs px-3 py-1.5"
            onClick={() => window.electronAPI.systemOpenUrl(post.url)}
          >
            Weiterlesen
          </button>
        </div>
      </div>
    </article>
  )
}

export default function News() {
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .packsGetPosts()
      .then((data) => { if (!cancelled) setPosts(data) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Fehler beim Laden der Beiträge') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="p-6 animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Neuigkeiten</h1>
        <p className="text-text-secondary mt-1 text-sm">Aktuelle Beiträge aus dem MyFTB-Blog.</p>
      </div>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-red-900/30 border border-red-700/50 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2, 3, 4, 5].map((i) => <SkeletonCard key={i} />)}
        </div>
      ) : posts.length === 0 ? (
        <div className="card px-6 py-16 text-center">
          <p className="text-text-secondary text-sm">Keine Beiträge gefunden.</p>
          <button
            className="btn-secondary mt-4"
            onClick={() => window.electronAPI.systemOpenUrl('https://myftb.de/blog')}
          >
            Blog besuchen
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {posts.map((post, i) => (<PostCard key={post.url || `post-${i}`} post={post} />
            ))}
          </div>
          <div className="mt-8 flex justify-center">
            <button
              className="btn-secondary px-6 py-2"
              onClick={() => window.electronAPI.systemOpenUrl('https://myftb.de/')}
            >
              Weitere Beiträge →
            </button>
          </div>
        </>
      )}
    </div>
  )
}
