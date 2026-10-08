import dynamic from 'next/dynamic'

const View = dynamic(() => import('../src/MainView').then(m => m.MainView), { ssr: false })

const Page = () => <View />

export default Page
