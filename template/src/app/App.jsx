import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 text-zinc-100 p-6">
      <h1 className="text-3xl font-bold text-emerald-400 mb-2">
        React Sandbox Ready
      </h1>
      <p className="text-sm text-zinc-400 mb-6">
        Edit <code className="text-emerald-300">src/app/App.jsx</code> in the terminal to see live HMR + S3 sync.
      </p>
      <button
        onClick={() => setCount((c) => c + 1)}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 cursor-pointer"
      >
        Count: {count}
      </button>
    </div>
  )
}

export default App
