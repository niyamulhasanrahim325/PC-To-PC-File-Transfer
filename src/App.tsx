import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Header } from './components/Header';
import { DropZone } from './components/DropZone';
import { TransferItemCard } from './components/TransferItemCard';
import { IncomingTransferModal } from './components/IncomingTransferModal';
import { QuickShareText } from './components/QuickShareText';
import { NetworkInfoModal } from './components/NetworkInfoModal';
import { InstructionsSection } from './components/InstructionsSection';
import { WifiScannerHub } from './components/WifiScannerHub';
import { DirectIpConnectBar } from './components/DirectIpConnectBar';
import { Language, translations } from './translations';
import {
  PeerInfo,
  TransferItem,
  IncomingOffer,
  SharedTextItem,
  LocalNetworkInfo,
} from './types';
import { PeerConnectionManager, SignalData } from './utils/webrtc';
import { playIncomingAlert, playCompletionChime } from './utils/audio';
import { saveBlobToChosenDirectoryOrDownload } from './utils/fileSystem';
import { formatBytes } from './utils/format';
import { UploadCloud, Wifi, HardDrive } from 'lucide-react';

const CHUNK_SIZE = 64 * 1024; // 64 KB chunks for ultra-fast throughput

function generateId(): string {
  return Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
}

function getInitialDeviceType(): 'desktop' | 'laptop' | 'mobile' {
  if (typeof window === 'undefined') return 'desktop';
  const ua = navigator.userAgent.toLowerCase();
  if (/mobile|android|iphone|ipad|tablet/.test(ua)) return 'mobile';
  if (window.innerWidth < 1024) return 'laptop';
  return 'desktop';
}

function getInitialDeviceName(): string {
  if (typeof window === 'undefined') return 'PC / Laptop';
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'Windows PC (Wi-Fi Dongle)';
  if (/Mac/.test(ua)) return 'MacBook (Wi-Fi)';
  if (/Linux/.test(ua)) return 'Linux PC (LAN)';
  return 'PC / Laptop';
}

export default function App() {
  const [lang, setLang] = useState<Language>('bn');
  const t = translations[lang];

  // Self identity
  const [selfInfo, setSelfInfo] = useState<PeerInfo>(() => {
    const savedName = localStorage.getItem('lan_device_name') || getInitialDeviceName();
    const savedType = (localStorage.getItem('lan_device_type') as any) || getInitialDeviceType();
    const savedTag = localStorage.getItem('lan_network_tag') || 'Wi-Fi Dongle';
    return {
      id: generateId(),
      name: savedName,
      deviceType: savedType,
      os: 'Windows',
      networkTag: savedTag,
      targetDrives: ['C:\\', 'D:\\', 'E:\\', 'Downloads'],
      roomId: 'local-mesh',
      joinedAt: Date.now(),
    };
  });

  // State
  const [isConnected, setIsConnected] = useState(false);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [pairedPeerId, setPairedPeerId] = useState<string | null>(null);
  const [connectingPeerId, setConnectingPeerId] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [currentRoomId, setCurrentRoomId] = useState<string>('local-mesh');
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);
  const [sharedTexts, setSharedTexts] = useState<SharedTextItem[]>([]);
  const [networkInfo, setNetworkInfo] = useState<LocalNetworkInfo | null>(null);
  const [isNetworkModalOpen, setIsNetworkModalOpen] = useState(false);
  const [isGlobalDragging, setIsGlobalDragging] = useState(false);

  // Refs for WebRTC, WebSocket and active transfer buffers
  const selfInfoRef = useRef(selfInfo);
  selfInfoRef.current = selfInfo;

  const wsRef = useRef<WebSocket | null>(null);
  const rtcManagerRef = useRef<PeerConnectionManager | null>(null);
  const switchWsHostRef = useRef<((host: string, targetPeerId?: string) => void) | null>(null);
  
  // Buffers for receiving files: transferId -> { chunks: ArrayBuffer[], totalBytes: number, meta: any, lastTime: number, lastBytes: number }
  const incomingBuffersRef = useRef<
    Map<
      string,
      {
        chunks: ArrayBuffer[];
        receivedBytes: number;
        fileSize: number;
        fileName: string;
        fileType: string;
        targetDrive: string;
        peerName: string;
        lastUpdate: number;
        lastBytes: number;
      }
    >
  >(new Map());

  // Outgoing transfer cancel tokens: transferId -> boolean
  const cancelledTransfersRef = useRef<Set<string>>(new Set());
  const activeSendingTransfersRef = useRef<Set<string>>(new Set());

  // Fetch local network info from Express backend
  useEffect(() => {
    fetch('/api/network-info')
      .then((res) => res.json())
      .then((data: LocalNetworkInfo) => {
        setNetworkInfo(data);
        if (data.drives && data.drives.length > 0) {
          setSelfInfo((prev) => ({ ...prev, targetDrives: data.drives }));
        }
      })
      .catch((err) => console.warn('Could not fetch network info:', err));
  }, []);

  // Send message helper
  const sendWsMessage = useCallback((msg: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Send WebRTC signal helper
  const handleSendSignal = useCallback(
    (targetId: string, data: SignalData) => {
      sendWsMessage({
        type: 'signal',
        fromId: selfInfo.id,
        targetId,
        data,
      });
    },
    [selfInfo.id, sendWsMessage]
  );

  // Handle data received over WebRTC Data Channel
  const handleDataChannelMessage = useCallback(
    (senderPeerId: string, data: ArrayBuffer | string) => {
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'file:meta') {
            // Meta packet before binary chunks
            incomingBuffersRef.current.set(parsed.transferId, {
              chunks: [],
              receivedBytes: 0,
              fileSize: parsed.fileSize,
              fileName: parsed.fileName,
              fileType: parsed.fileType,
              targetDrive: parsed.targetDrive || 'D:\\',
              peerName: parsed.peerName,
              lastUpdate: Date.now(),
              lastBytes: 0,
            });
          }
        } catch {}
        return;
      }

      // Binary chunk received over WebRTC
      // The first 36 bytes or JSON prefix could be header, or simple slice:
      // Let's use a standard 36-byte transferId header in the binary chunk
      if (data.byteLength < 36) return;

      const headerBytes = new Uint8Array(data, 0, 36);
      const transferId = new TextDecoder().decode(headerBytes).trim();
      const chunkData = data.slice(36);

      handleReceivedChunk(transferId, chunkData, 'webrtc');
    },
    []
  );

  // Process a chunk of received file (either from WebRTC or WebSocket relay)
  const handleReceivedChunk = (
    transferId: string,
    chunkData: ArrayBuffer,
    mode: 'webrtc' | 'relay'
  ) => {
    const buf = incomingBuffersRef.current.get(transferId);
    if (!buf) return;

    buf.chunks.push(chunkData);
    buf.receivedBytes += chunkData.byteLength;

    const now = Date.now();
    const timeDiff = (now - buf.lastUpdate) / 1000;

    // Calculate speed every ~250ms
    let speed = 0;
    if (timeDiff >= 0.25) {
      const bytesDiff = buf.receivedBytes - buf.lastBytes;
      speed = bytesDiff / timeDiff;
      buf.lastUpdate = now;
      buf.lastBytes = buf.receivedBytes;
    }

    const progress = Math.min(100, (buf.receivedBytes / buf.fileSize) * 100);

    // Update state throttled
    setTransfers((prev) =>
      prev.map((item) => {
        if (item.transferId === transferId) {
          return {
            ...item,
            transferredBytes: buf.receivedBytes,
            progress,
            speedBytesPerSec: speed > 0 ? speed : item.speedBytesPerSec,
            mode,
            status: 'transferring',
          };
        }
        return item;
      })
    );

    // Check if file is completely received!
    if (buf.receivedBytes >= buf.fileSize) {
      const fullBlob = new Blob(buf.chunks, { type: buf.fileType || 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(fullBlob);

      playCompletionChime();

      // Automatically save to chosen drive/folder or trigger download
      saveBlobToChosenDirectoryOrDownload(fullBlob, buf.fileName, buf.targetDrive);

      setTransfers((prev) =>
        prev.map((item) => {
          if (item.transferId === transferId) {
            return {
              ...item,
              transferredBytes: buf.fileSize,
              progress: 100,
              status: 'completed',
              blobUrl,
              endTime: Date.now(),
            };
          }
          return item;
        })
      );

      incomingBuffersRef.current.delete(transferId);
    }
  };

  // Initialize WebRTC Manager
  useEffect(() => {
    rtcManagerRef.current = new PeerConnectionManager(
      selfInfo.id,
      handleSendSignal,
      handleDataChannelMessage
    );

    return () => {
      rtcManagerRef.current?.cleanupAll();
    };
  }, [selfInfo.id, handleSendSignal, handleDataChannelMessage]);

  // Connect WebSocket
  useEffect(() => {
    let reconnectTimer: any = null;
    let activeHost = window.location.host;
    let initialPairTarget: string | undefined;

    function connectWs(customHost?: string, pairTarget?: string) {
      if (customHost) {
        activeHost = customHost;
      }
      if (pairTarget) {
        initialPairTarget = pairTarget;
      }

      try {
        if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
          wsRef.current.close();
        }
      } catch {}

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${activeHost}/ws`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        // Announce device to the network room
        const info = selfInfoRef.current;
        ws.send(
          JSON.stringify({
            type: 'join',
            id: info.id,
            name: info.name,
            deviceType: info.deviceType,
            os: info.os,
            networkTag: info.networkTag,
            targetDrives: info.targetDrives,
            roomId: currentRoomId,
            ip: info.ip,
          })
        );

        if (initialPairTarget) {
          const target = initialPairTarget;
          initialPairTarget = undefined;
          ws.send(
            JSON.stringify({
              type: 'pair:request',
              fromPeer: info,
              targetId: target,
              autoAccept: true,
            })
          );
          rtcManagerRef.current?.initiateConnection(target);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            case 'room:peers': {
              setPeers(msg.peers || []);
              if (msg.detectedIp) {
                setSelfInfo((prev) => {
                  if (prev.ip === msg.detectedIp) return prev;
                  return { ...prev, ip: msg.detectedIp };
                });
              }
              break;
            }

            case 'pair:ip-found': {
              if (msg.peer) {
                playCompletionChime();
                setPairedPeerId(msg.peer.id);
                setSelectedPeerId(msg.peer.id);
                setConnectingPeerId(null);
                rtcManagerRef.current?.initiateConnection(msg.peer.id);
              }
              break;
            }

            case 'peer:joined': {
              setPeers((prev) => {
                const filtered = prev.filter((p) => p.id !== msg.peer.id);
                return [...filtered, msg.peer];
              });
              break;
            }

            case 'peer:updated': {
              setPeers((prev) =>
                prev.map((p) => (p.id === msg.peer.id ? msg.peer : p))
              );
              break;
            }

            case 'peer:left': {
              setPeers((prev) => prev.filter((p) => p.id !== msg.peerId));
              rtcManagerRef.current?.cleanupPeer(msg.peerId);
              break;
            }

            case 'scan:response': {
              setPeers(msg.peers || []);
              setIsScanning(false);
              break;
            }

            case 'pair:request': {
              playIncomingAlert();
              const partnerId = msg.fromPeer?.id;
              if (partnerId) {
                setPairedPeerId(partnerId);
                setSelectedPeerId(partnerId);
                // Confirm pairing back
                sendWsMessage({
                  type: 'pair:accept',
                  fromId: selfInfo.id,
                  targetId: partnerId,
                });
                rtcManagerRef.current?.initiateConnection(partnerId);
              }
              break;
            }

            case 'pair:accepted': {
              playCompletionChime();
              const partnerId = msg.fromPeer?.id || msg.targetId;
              setPairedPeerId(partnerId);
              setSelectedPeerId(partnerId);
              setConnectingPeerId(null);
              break;
            }

            case 'pair:confirmed': {
              playCompletionChime();
              setPairedPeerId(msg.pairedWithId);
              setSelectedPeerId(msg.pairedWithId);
              setConnectingPeerId(null);
              break;
            }

            case 'pair:disconnected': {
              setPairedPeerId((curr) => (curr === msg.fromId ? null : curr));
              break;
            }

            case 'signal': {
              rtcManagerRef.current?.handleSignal(msg.fromId, msg.data);
              break;
            }

            case 'file:offer': {
              // Another PC wants to send a file
              playIncomingAlert();
              const sender = peers.find((p) => p.id === msg.fromId);

              // Prepare local incoming buffer
              incomingBuffersRef.current.set(msg.transferId, {
                chunks: [],
                receivedBytes: 0,
                fileSize: msg.file.size,
                fileName: msg.file.name,
                fileType: msg.file.type,
                targetDrive: msg.file.suggestedDrive || 'Downloads',
                peerName: sender?.name || 'Connected PC',
                lastUpdate: Date.now(),
                lastBytes: 0,
              });

              // Add item to transfers list
              setTransfers((prev) => [
                {
                  id: generateId(),
                  transferId: msg.transferId,
                  fileName: msg.file.name,
                  fileSize: msg.file.size,
                  fileType: msg.file.type,
                  direction: 'receive',
                  peerId: msg.fromId,
                  peerName: sender?.name || 'Connected PC',
                  progress: 0,
                  transferredBytes: 0,
                  speedBytesPerSec: 0,
                  status: 'transferring',
                  mode: 'webrtc',
                  sourceDrive: msg.file.sourceDrive,
                  targetDrive: msg.file.suggestedDrive || 'Downloads',
                  startTime: Date.now(),
                },
                ...prev,
              ]);

              // Auto-accept and reply to sender so file streaming begins immediately
              sendWsMessage({
                type: 'file:response',
                fromId: selfInfo.id,
                targetId: msg.fromId,
                transferId: msg.transferId,
                accepted: true,
                chosenDrive: msg.file.suggestedDrive || 'Downloads',
              });
              break;
            }

            case 'file:response': {
              // The recipient approved or declined
              if (msg.accepted) {
                // Start streaming the file to the recipient!
                startSendingFile(msg.transferId, msg.fromId, msg.chosenDrive);
              } else {
                setTransfers((prev) =>
                  prev.map((item) =>
                    item.transferId === msg.transferId
                      ? { ...item, status: 'declined' }
                      : item
                  )
                );
              }
              break;
            }

            case 'file:relay:chunk': {
              // Fallback chunk via WebSocket
              // Binary data was converted to Base64 or array
              if (msg.data) {
                // Decode base64 to ArrayBuffer
                const binaryStr = atob(msg.data);
                const len = binaryStr.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                  bytes[i] = binaryStr.charCodeAt(i);
                }
                handleReceivedChunk(msg.transferId, bytes.buffer, 'relay');
              }
              break;
            }

            case 'file:cancel': {
              cancelledTransfersRef.current.add(msg.transferId);
              incomingBuffersRef.current.delete(msg.transferId);
              setTransfers((prev) =>
                prev.map((item) =>
                  item.transferId === msg.transferId
                    ? { ...item, status: 'cancelled' }
                    : item
                )
              );
              break;
            }

            case 'clipboard:received': {
              const sender = peers.find((p) => p.id === msg.fromId);
              setSharedTexts((prev) => [
                {
                  id: generateId(),
                  fromId: msg.fromId,
                  fromName: sender?.name || 'Remote PC',
                  text: msg.text,
                  timestamp: msg.timestamp || Date.now(),
                  isSelf: false,
                },
                ...prev.slice(0, 50),
              ]);
              break;
            }
          }
        } catch (err) {
          console.error('WebSocket parse error:', err);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        reconnectTimer = setTimeout(connectWs, 2000);
      };

      ws.onerror = () => {
        setIsConnected(false);
      };
    }

    switchWsHostRef.current = (host: string, targetPeerId?: string) => {
      connectWs(host, targetPeerId);
    };

    connectWs();

    return () => {
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [currentRoomId]);

  // Active files stored in memory for sender: transferId -> File
  const pendingFilesRef = useRef<Map<string, File>>(new Map());

  // Function to initiate file sending
  const handleSendFiles = (
    files: File[],
    targetPeerIds: string[],
    sourceDrive: string,
    targetDrive: string
  ) => {
    for (const file of files) {
      for (const targetId of targetPeerIds) {
        const transferId = generateId();
        pendingFilesRef.current.set(transferId, file);

        const targetPeer = peers.find((p) => p.id === targetId);

        // Add to transfers UI
        setTransfers((prev) => [
          {
            id: generateId(),
            transferId,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            direction: 'send',
            peerId: targetId,
            peerName: targetPeer?.name || 'Remote PC',
            progress: 0,
            transferredBytes: 0,
            speedBytesPerSec: 0,
            status: 'waiting_approval',
            mode: 'webrtc',
            sourceDrive,
            targetDrive,
            startTime: Date.now(),
          },
          ...prev,
        ]);

        // Attempt WebRTC handshake in parallel
        rtcManagerRef.current?.initiateConnection(targetId);

        // Send transfer offer to recipient
        sendWsMessage({
          type: 'file:offer',
          fromId: selfInfo.id,
          targetId,
          transferId,
          file: {
            name: file.name,
            size: file.size,
            type: file.type,
            sourceDrive,
            suggestedDrive: targetDrive,
          },
        });

        // Instant-start fallback: Begin streaming directly after short delay without waiting forever
        setTimeout(() => {
          const fileToTransfer = pendingFilesRef.current.get(transferId);
          if (fileToTransfer) {
            startSendingFile(transferId, targetId, targetDrive);
          }
        }, 350);
      }
    }
  };

  // Start reading file in chunks and streaming to recipient
  const startSendingFile = async (
    transferId: string,
    targetPeerId: string,
    targetDrive: string
  ) => {
    const file = pendingFilesRef.current.get(transferId);
    if (!file) return;

    if (activeSendingTransfersRef.current.has(transferId)) return;
    activeSendingTransfersRef.current.add(transferId);

    setTransfers((prev) =>
      prev.map((item) =>
        item.transferId === transferId
          ? { ...item, status: 'transferring', targetDrive }
          : item
      )
    );

    // Determine whether to use WebRTC DataChannel (Direct P2P max speed) or WebSocket relay
    const useWebRtc = rtcManagerRef.current?.isDataChannelOpen(targetPeerId);
    const dc = useWebRtc ? rtcManagerRef.current?.getDataChannel(targetPeerId) : null;

    const mode = dc ? 'webrtc' : 'relay';

    // If using WebRTC, send metadata first
    if (dc) {
      dc.send(
        JSON.stringify({
          type: 'file:meta',
          transferId,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          targetDrive,
          peerName: selfInfo.name,
        })
      );
    }

    let offset = 0;
    let lastTime = Date.now();
    let lastOffset = 0;

    // Helper to format 36-byte transferId header for WebRTC chunks
    const idEncoder = new TextEncoder();
    const idBytes = new Uint8Array(36);
    idBytes.set(idEncoder.encode(transferId.padEnd(36)));

    while (offset < file.size) {
      // Check if user cancelled
      if (cancelledTransfersRef.current.has(transferId)) {
        pendingFilesRef.current.delete(transferId);
        return;
      }

      const chunkSlice = file.slice(offset, offset + CHUNK_SIZE);
      const chunkBuffer = await chunkSlice.arrayBuffer();

      if (dc && dc.readyState === 'open') {
        // High speed WebRTC transfer
        // Buffer control: wait if buffer has over 2MB pending
        while (dc.bufferedAmount > 2 * 1024 * 1024) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          if (cancelledTransfersRef.current.has(transferId)) return;
        }

        // Pack header (36 bytes) + chunkBuffer
        const packet = new Uint8Array(36 + chunkBuffer.byteLength);
        packet.set(idBytes, 0);
        packet.set(new Uint8Array(chunkBuffer), 36);

        dc.send(packet.buffer);
      } else {
        // Fallback WebSocket Relay
        // Convert arrayBuffer to base64
        let binary = '';
        const bytes = new Uint8Array(chunkBuffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64Data = btoa(binary);

        sendWsMessage({
          type: 'file:relay:chunk',
          fromId: selfInfo.id,
          targetId: targetPeerId,
          transferId,
          data: base64Data,
        });

        // Small delay to prevent flooding WebSocket server
        if (offset % (CHUNK_SIZE * 8) === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }

      offset += chunkBuffer.byteLength;

      // Update progress and speed
      const now = Date.now();
      const timeDiff = (now - lastTime) / 1000;
      let speed = 0;
      if (timeDiff >= 0.2) {
        speed = (offset - lastOffset) / timeDiff;
        lastTime = now;
        lastOffset = offset;

        const progress = Math.min(100, (offset / file.size) * 100);
        setTransfers((prev) =>
          prev.map((item) => {
            if (item.transferId === transferId) {
              return {
                ...item,
                transferredBytes: offset,
                progress,
                speedBytesPerSec: speed,
                mode,
              };
            }
            return item;
          })
        );
      }
    }

    // Done sending
    playCompletionChime();
    setTransfers((prev) =>
      prev.map((item) =>
        item.transferId === transferId
          ? {
              ...item,
              transferredBytes: file.size,
              progress: 100,
              status: 'completed',
              endTime: Date.now(),
            }
          : item
      )
    );
    pendingFilesRef.current.delete(transferId);
    activeSendingTransfersRef.current.delete(transferId);
  };

  // Recipient accepts incoming offer
  const handleAcceptOffer = (transferId: string, chosenDrive: string) => {
    if (!incomingOffer) return;
    const targetPeerId = incomingOffer.fromId;

    // Send response
    sendWsMessage({
      type: 'file:response',
      fromId: selfInfo.id,
      targetId: targetPeerId,
      transferId,
      accepted: true,
      chosenDrive,
    });

    setIncomingOffer(null);

    setTransfers((prev) =>
      prev.map((item) =>
        item.transferId === transferId
          ? { ...item, status: 'transferring', targetDrive: chosenDrive }
          : item
      )
    );
  };

  // Recipient declines incoming offer
  const handleDeclineOffer = (transferId: string) => {
    if (!incomingOffer) return;
    const targetPeerId = incomingOffer.fromId;

    sendWsMessage({
      type: 'file:response',
      fromId: selfInfo.id,
      targetId: targetPeerId,
      transferId,
      accepted: false,
      reason: 'Declined by recipient',
    });

    incomingBuffersRef.current.delete(transferId);
    setIncomingOffer(null);

    setTransfers((prev) =>
      prev.map((item) =>
        item.transferId === transferId ? { ...item, status: 'declined' } : item
      )
    );
  };

  // Cancel an ongoing transfer
  const handleCancelTransfer = (transferId: string) => {
    cancelledTransfersRef.current.add(transferId);
    incomingBuffersRef.current.delete(transferId);
    pendingFilesRef.current.delete(transferId);

    const targetTransfer = transfers.find((t) => t.transferId === transferId);
    if (targetTransfer) {
      sendWsMessage({
        type: 'file:cancel',
        fromId: selfInfo.id,
        targetId: targetTransfer.peerId,
        transferId,
      });
    }

    setTransfers((prev) =>
      prev.map((item) =>
        item.transferId === transferId ? { ...item, status: 'cancelled' } : item
      )
    );
  };

  // Save received file
  const handleSaveToDisk = (item: TransferItem) => {
    if (!item.blobUrl) return;
    const a = document.createElement('a');
    a.href = item.blobUrl;
    a.download = item.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Remove item from transfers list
  const handleClearTransfer = (id: string) => {
    setTransfers((prev) => prev.filter((item) => item.id !== id));
  };

  // Send quick text
  const handleSendText = (text: string, targetPeerId?: string) => {
    sendWsMessage({
      type: 'clipboard:send',
      fromId: selfInfo.id,
      targetId: targetPeerId,
      text,
    });

    setSharedTexts((prev) => [
      {
        id: generateId(),
        fromId: selfInfo.id,
        fromName: selfInfo.name,
        text,
        timestamp: Date.now(),
        isSelf: true,
      },
      ...prev.slice(0, 50),
    ]);
  };

  // Update profile
  const handleUpdateName = (newName: string) => {
    setSelfInfo((prev) => ({ ...prev, name: newName }));
    localStorage.setItem('lan_device_name', newName);
    sendWsMessage({
      type: 'update:profile',
      name: newName,
    });
  };

  const handleUpdateDeviceType = (newType: 'desktop' | 'laptop' | 'mobile') => {
    setSelfInfo((prev) => ({ ...prev, deviceType: newType }));
    localStorage.setItem('lan_device_type', newType);
  };

  const handleUpdateNetworkTag = (newTag: string) => {
    setSelfInfo((prev) => ({ ...prev, networkTag: newTag }));
    localStorage.setItem('lan_network_tag', newTag);
    sendWsMessage({
      type: 'update:profile',
      networkTag: newTag,
    });
  };

  const handleSwitchRoom = (newRoomId: string) => {
    setCurrentRoomId(newRoomId);
    setPeers([]);
    sendWsMessage({
      type: 'switch:room',
      newRoomId,
    });
  };

  // Global Drag & Drop Handler (Dragging from Windows Desktop/Explorer directly into window)
  useEffect(() => {
    const handleWindowDragOver = (e: DragEvent) => {
      e.preventDefault();
      setIsGlobalDragging(true);
    };

    const handleWindowDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) {
        setIsGlobalDragging(false);
      }
    };

    const handleWindowDrop = (e: DragEvent) => {
      e.preventDefault();
      setIsGlobalDragging(false);
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        const filesArray = Array.from(e.dataTransfer.files);
        // If there's an active peer selected or available, initiate transfer
        if (peers.length > 0) {
          const targetIds = selectedPeerId ? [selectedPeerId] : [peers[0].id];
          handleSendFiles(filesArray, targetIds, 'Any Drive', 'D:\\');
        }
      }
    };

    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('dragleave', handleWindowDragLeave);
    window.addEventListener('drop', handleWindowDrop);

    return () => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('dragleave', handleWindowDragLeave);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, [peers, selectedPeerId]);

  const handleConnectToPeer = (peerId: string) => {
    setConnectingPeerId(peerId);
    const peer = peers.find((p) => p.id === peerId);

    // Keep the active WebSocket connection stable and initiate pairing directly
    setPairedPeerId(peerId);
    setSelectedPeerId(peerId);
    playCompletionChime();

    sendWsMessage({
      type: 'pair:request',
      fromId: selfInfo.id,
      targetId: peerId,
      autoAccept: true,
    });

    rtcManagerRef.current?.initiateConnection(peerId);

    // If peer has an external IP on LAN, also ping via HTTP direct-connect without closing our WebSocket
    if (peer && peer.ip && peer.ip !== selfInfo.ip && !peer.ip.startsWith('127.')) {
      fetch(`http://${peer.ip}:3000/api/direct-connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peer: selfInfoRef.current }),
      }).catch(() => {});
    }

    setTimeout(() => {
      setConnectingPeerId(null);
    }, 1200);
  };

  const handleDisconnectPeer = (peerId: string) => {
    setPairedPeerId(null);
    setSelectedPeerId(null);
    sendWsMessage({
      type: 'pair:disconnect',
      fromId: selfInfo.id,
      targetId: peerId,
    });
  };

  const handleRefreshScan = async () => {
    setIsScanning(true);
    sendWsMessage({ type: 'scan:request' });

    // Active LAN subnet scan
    const currentIp = selfInfo.ip || networkInfo?.localIps?.[0]?.address;
    if (currentIp && currentIp.includes('.')) {
      const parts = currentIp.split('.');
      if (parts.length === 4) {
        const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
        const myLastOctet = parseInt(parts[3], 10);

        const targetOctets = new Set<number>();
        // 1. Neighboring IPs (-15 to +15)
        for (let offset = -15; offset <= 15; offset++) {
          const oct = myLastOctet + offset;
          if (oct >= 2 && oct <= 254 && oct !== myLastOctet) {
            targetOctets.add(oct);
          }
        }
        // 2. Common DHCP IP ranges
        for (let i = 2; i <= 25; i++) {
          if (i !== myLastOctet) targetOctets.add(i);
        }
        for (let i = 100; i <= 115; i++) {
          if (i !== myLastOctet) targetOctets.add(i);
        }

        const octetList = Array.from(targetOctets);
        const batchSize = 15;
        const freshDiscovered: PeerInfo[] = [];

        for (let b = 0; b < octetList.length; b += batchSize) {
          const batch = octetList.slice(b, b + batchSize);
          await Promise.allSettled(
            batch.map(async (oct) => {
              const probeIp = `${subnet}.${oct}`;
              try {
                const res = await fetch(`http://${probeIp}:3000/api/network-info`, {
                  signal: AbortSignal.timeout(600),
                });
                if (res.ok) {
                  const info = await res.json();
                  const discoveredPeer: PeerInfo = {
                    id: `peer-${probeIp.replace(/\./g, '-')}`,
                    name: info.hostname ? `${info.hostname}` : `Windows PC (${probeIp})`,
                    deviceType: 'desktop',
                    os: 'Windows',
                    networkTag: 'Wi-Fi LAN',
                    targetDrives: (info.drives && info.drives.length > 0) ? info.drives : ['C:\\ (System Disk)', 'D:\\ (Data / Files)', 'Downloads'],
                    roomId: 'local-mesh',
                    ip: probeIp,
                    joinedAt: Date.now(),
                  };
                  freshDiscovered.push(discoveredPeer);
                }
              } catch {}
            })
          );
        }

        // Clean up: Keep WebSocket room peers and only currently active probed peers
        setPeers((prev) => {
          const wsPeers = prev.filter((p) => !p.id.startsWith('peer-'));
          const combined = [...wsPeers];
          for (const f of freshDiscovered) {
            if (!combined.some((p) => p.ip === f.ip || p.id === f.id)) {
              combined.push(f);
            }
          }
          return combined;
        });
      }
    }

    setTimeout(() => setIsScanning(false), 800);
  };

  const handleConnectByIp = async (rawIp: string): Promise<boolean> => {
    const cleanIp = rawIp
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/:[0-9]+.*$/, '')
      .trim()
      .toLowerCase();

    if (!cleanIp) return false;

    // 1. Check if any connected peer has this IP or matching name
    const foundPeer = peers.find((p) => {
      const pIp = (p.ip || '').toLowerCase();
      return (
        pIp === cleanIp ||
        pIp.includes(cleanIp) ||
        cleanIp.includes(pIp) ||
        p.name.toLowerCase().includes(cleanIp)
      );
    });

    if (foundPeer) {
      handleConnectToPeer(foundPeer.id);
      return true;
    }

    const targetHost = `${cleanIp}:3000`;

    // 2. Direct HTTP probe to the other PC's API
    try {
      const postRes = await fetch(`http://${targetHost}/api/direct-connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peer: selfInfoRef.current }),
        signal: AbortSignal.timeout(3000),
      });

      if (postRes.ok) {
        const postData = await postRes.json();
        const remotePeers: PeerInfo[] = postData.peers || [];
        const remoteTarget: PeerInfo =
          remotePeers.find((p) => p.id !== selfInfo.id) ||
          remotePeers[0] || {
            id: `peer-${cleanIp.replace(/\./g, '-')}`,
            name: `Windows PC (${cleanIp})`,
            deviceType: 'desktop',
            os: 'Windows',
            networkTag: 'Wi-Fi LAN',
            roomId: 'local-mesh',
            ip: cleanIp,
            joinedAt: Date.now(),
          };

        setPeers((prev) => {
          const filtered = prev.filter((p) => p.id !== remoteTarget.id && p.ip !== cleanIp);
          return [...filtered, remoteTarget];
        });

        setPairedPeerId(remoteTarget.id);
        setSelectedPeerId(remoteTarget.id);

        // Switch our WebSocket to the target machine's server so both peers communicate on the same signaling channel
        switchWsHostRef.current?.(targetHost, remoteTarget.id);
        playCompletionChime();
        return true;
      }
    } catch (err) {
      console.warn('Direct HTTP connect attempt failed:', err);
    }

    // 3. Fallback: Direct WebSocket connection to remote PC
    try {
      const testWs = new WebSocket(`ws://${targetHost}/ws`);
      const wsConnectPromise = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          try { testWs.close(); } catch {}
          resolve(false);
        }, 3000);

        testWs.onopen = () => {
          clearTimeout(timeout);
          try { testWs.close(); } catch {}

          const syntheticTargetId = `peer-${cleanIp.replace(/\./g, '-')}`;
          const syntheticPeer: PeerInfo = {
            id: syntheticTargetId,
            name: `Windows PC (${cleanIp})`,
            deviceType: 'desktop',
            os: 'Windows',
            networkTag: 'Wi-Fi LAN',
            roomId: 'local-mesh',
            ip: cleanIp,
            joinedAt: Date.now(),
          };

          setPeers((prev) => {
            const filtered = prev.filter((p) => p.ip !== cleanIp && p.id !== syntheticTargetId);
            return [...filtered, syntheticPeer];
          });
          setPairedPeerId(syntheticTargetId);
          setSelectedPeerId(syntheticTargetId);
          playCompletionChime();
          resolve(true);
        };

        testWs.onerror = () => {
          clearTimeout(timeout);
          resolve(false);
        };
      });

      const wsOk = await wsConnectPromise;
      if (wsOk) return true;
    } catch {}

    // 4. Also ask local server in case remote peer connected to us
    sendWsMessage({
      type: 'pair:by-ip',
      fromId: selfInfo.id,
      targetIp: cleanIp,
    });

    return false;
  };

  const pairedPeer = peers.find((p) => p.id === pairedPeerId);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased">
      {/* Top Header */}
      <Header
        lang={lang}
        onToggleLang={() => setLang((prev) => (prev === 'bn' ? 'en' : 'bn'))}
        onlineCount={peers.length + 1}
        isConnected={isConnected}
        pairedPeerName={pairedPeer?.name}
        onOpenNetworkModal={() => setIsNetworkModalOpen(true)}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">

        {/* Direct IP Connect Bar (Paste this PC's IP or another PC's IP) */}
        <DirectIpConnectBar
          myIp={selfInfo.ip || networkInfo?.localIps?.[0]?.address || '192.168.1.x'}
          networkInfo={networkInfo}
          pairedPeer={pairedPeer || null}
          onConnectByIp={handleConnectByIp}
          lang={lang}
        />

        {/* Mobile-Style Wi-Fi PC Scanner Hub (Search, Scan, Select & Green Connected Status) */}
        <WifiScannerHub
          peers={peers}
          pairedPeerId={pairedPeerId}
          connectingPeerId={connectingPeerId}
          onConnectToPeer={handleConnectToPeer}
          onDisconnectPeer={handleDisconnectPeer}
          onRefreshScan={handleRefreshScan}
          isScanning={isScanning}
          lang={lang}
          onOpenConnectModal={() => setIsNetworkModalOpen(true)}
        />

        {/* Main Drag & Drop Zone */}
        <DropZone
          peers={peers}
          selectedPeerId={pairedPeerId || selectedPeerId}
          onSelectPeer={(id) => {
            setSelectedPeerId(id);
            if (id) setPairedPeerId(id);
          }}
          onSendFiles={handleSendFiles}
          lang={lang}
        />

        {/* Active Transfers & Live Speed Section */}
        {transfers.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <span>{t.activeTransfers}</span>
                <span className="text-xs font-mono font-normal text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded-full">
                  {transfers.length}
                </span>
              </h3>
              <button
                onClick={() =>
                  setTransfers((prev) =>
                    prev.filter((t) => t.status === 'transferring' || t.status === 'waiting_approval')
                  )
                }
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
              >
                {lang === 'bn' ? 'সম্পন্নগুলো মুছুন' : 'Clear completed'}
              </button>
            </div>

            <div className="space-y-3">
              {transfers.map((item) => (
                <TransferItemCard
                  key={item.id}
                  item={item}
                  lang={lang}
                  onCancel={handleCancelTransfer}
                  onSaveToDisk={handleSaveToDisk}
                  onClear={handleClearTransfer}
                />
              ))}
            </div>
          </div>
        )}

        {/* Quick Text & Clipboard Sharing */}
        <QuickShareText
          items={sharedTexts}
          lang={lang}
          peers={peers}
          onSendText={handleSendText}
          onClear={() => setSharedTexts([])}
        />

        {/* Instructions & Help */}
        <InstructionsSection lang={lang} />
      </main>

      {/* Global Drag & Drop Overlay */}
      {isGlobalDragging && (
        <div className="fixed inset-0 z-50 bg-indigo-950/80 backdrop-blur-md border-4 border-dashed border-indigo-400 flex flex-col items-center justify-center text-white space-y-4 pointer-events-none animate-in fade-in duration-100">
          <div className="w-20 h-20 rounded-3xl bg-indigo-600 flex items-center justify-center shadow-2xl shadow-indigo-600/50 animate-bounce">
            <UploadCloud className="w-10 h-10" />
          </div>
          <div className="text-center space-y-1">
            <h2 className="text-2xl font-bold tracking-tight">
              {lang === 'bn' ? 'যেকোনো স্থানে ফাইল ড্রপ করুন!' : 'Drop Files Anywhere to Transfer!'}
            </h2>
            <p className="text-sm text-indigo-200">
              {lang === 'bn'
                ? 'ফাইলটি স্বয়ংক্রিয়ভাবে লোকাল ওয়াইফাইয়ের মাধ্যমে ট্রান্সফার হবে'
                : 'Files will be sent immediately over local Wi-Fi'}
            </p>
          </div>
        </div>
      )}

      {/* Modals */}
      <IncomingTransferModal
        offer={incomingOffer}
        lang={lang}
        onAccept={handleAcceptOffer}
        onDecline={handleDeclineOffer}
      />

      <NetworkInfoModal
        isOpen={isNetworkModalOpen}
        onClose={() => setIsNetworkModalOpen(false)}
        lang={lang}
        networkInfo={networkInfo}
        currentRoomId={currentRoomId}
        onSwitchRoom={handleSwitchRoom}
      />

      {/* Footer */}
      <footer className="mt-12 py-6 border-t border-slate-800 text-center text-xs text-slate-500">
        <p>
          Wi-Fi LAN File Drop · {lang === 'bn' ? 'লোকাল ওয়াইফাই ও ল্যান ফাইল ট্রান্সফার' : 'Direct LAN & Wi-Fi P2P Transfer'} · 100% Local & Fast
        </p>
      </footer>
    </div>
  );
}
