'use client';
import { useParams } from 'next/navigation';
import AplicacionesTab from '../../AplicacionesTab';
export default function Page() { const { tab } = useParams(); return <AplicacionesTab tab={tab} />; }
