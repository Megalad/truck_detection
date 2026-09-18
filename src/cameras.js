// The 15 cameras actually monitored right now (Live Monitoring grid + Report
// Chart both read this same list, so they can never drift apart). Stream
// URLs pulled verbatim from camera.json, the org's master CCTV list of 112 —
// this is the subset we actually watch.
export const CAMERAS = [
  { id: "TV27CL1", title: "TV27CL1 M9-21+900-TY", url: "http://1.4.213.19:1922/live/TV27CL1-M9-21_900-TY.stream/playlist.m3u8" },
  { id: "TV03CL2", title: "TV03CL2 M9-0+000-KL", url: "http://1.4.213.19:1921/live/TV03CL2-M9-0_000-KL.stream/playlist.m3u8" },
  { id: "TV28CL2", title: "TV28CL2 M9-21+900-TY", url: "http://1.4.213.19:1922/live/TV28CL2-M9-21_900-TY.stream/playlist.m3u8" },
  { id: "TV55CL2", title: "TV55CL2 M9-43+000-RIT", url: "http://1.4.213.19:1923/live/TV55CL2-M9-43_000-RIT.stream/playlist.m3u8" },
  { id: "TV64CL1", title: "TV64CL1 M9-47+926-RIT", url: "http://1.4.213.19:1924/live/TV64CL1-M9-47_926-RIT.stream/playlist.m3u8" },
  { id: "TV73CL1", title: "TV73CL1 M9-54+000-TC", url: "http://1.4.213.19:1924/live/TV73CL1-M9-54_000-TC.stream/playlist.m3u8" },
  { id: "TV76CL2", title: "TV76CL2 M9-55+250-ON", url: "http://1.4.213.19:1925/live/TV76CL2-M9-55_250-ON.stream/playlist.m3u8" },
  { id: "TV16CL1", title: "TV16CL1 M7-11+350-RK", url: "http://1.4.213.19:1926/live/TV16CL1-M7-11_350-RK.stream/playlist.m3u8" },
  { id: "TV18CL", title: "TV18CL M7-12+000-LKB", url: "http://1.4.213.19:1926/live/TV18CL-M7-12_000-LKB.stream/playlist.m3u8" },
  { id: "TV20CL", title: "TV20CL M7-13+400-KSR", url: "http://1.4.213.19:1926/live/TV20CL-M7-13_400-KSR.stream/playlist.m3u8" },
  { id: "TV27CL2", title: "TV27CL2 M7-20+790-LKB", url: "http://1.4.213.19:1926/live/TV27CL2-M7-20_790-LKB.stream/playlist.m3u8" },
  { id: "TV11L", title: "TV11L M7-1+250-BP", url: "http://1.4.213.19:1932/live/TV11L-M7-0_050-BP.stream/playlist.m3u8" },
  { id: "TV13CL1", title: "TV13CL1 M7-78+780-BP", url: "http://1.4.213.19:1930/live/TV13CL1-M7-78_780-BP.stream/playlist.m3u8" },
  { id: "TV67R", title: "TV67R M7-78+850-BP", url: "http://1.4.213.19:1930/live/TV67R-M7-78_850-BP.stream/playlist.m3u8" },
  { id: "TV35CL2", title: "TV35CL2 M7-99+430-NK", url: "http://1.4.213.19:1931/live/TV35CL2-M7-99_430-NK.stream/playlist.m3u8" },
];
