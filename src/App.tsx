import { useEffect, useState } from 'react'
import { PhysicsCanvas } from './components/PhysicsCanvas'
import { Chat } from './components/Chat'
import { NicknameModal } from './components/NicknameModal'

const NICK_KEY = 'pp:nickname'

export function App() {
  const [nickname, setNickname] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem(NICK_KEY)
    if (saved) setNickname(saved)
    else setAsking(true)
  }, [])

  function handleNickname(value: string) {
    localStorage.setItem(NICK_KEY, value)
    setNickname(value)
    setAsking(false)
  }

  return (
    <div className="relative h-full w-full">
      <PhysicsCanvas />
      {nickname && <Chat nickname={nickname} onChangeNickname={() => setAsking(true)} />}
      {asking && <NicknameModal onSubmit={handleNickname} />}
    </div>
  )
}
