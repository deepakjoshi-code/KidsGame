#!/usr/bin/env python3
"""Cut the characters out of Samar's "Mousie" book scans as transparent PNGs.

Usage:  python3 -I tools/cut_characters.py [--pdf PATH] [--pages DIR] [--debug DIR]
                                           [--only name,name] [--sheet PNG]

Pages 1-7 of the book PDF are rendered at 300 dpi with pdftoppm (page 8, the
author photo, is never rendered or used).  Each cutout is a GrabCut seeded by
hand-placed hints in 300-dpi page coordinates:

  outer  polygon; everything outside is definite background
  fg     polylines/polygons painted as definite foreground (with stroke width)
  bg     polygons painted as definite background (bubbles, other characters)
  bg_over  like bg but painted after fg, so it wins where they overlap
  cut    polygons removed from the final mask (overlapping objects)
  keep   polygons forced into the final mask (thin parts GrabCut drops)

then cleaned (open/close, connected components, small hole fill), feathered,
scaled to <= 900 px long side, cropped to the alpha bbox + 6 px and written to
assets/chars/.  The "characters" section of assets/manifest.json is merged in
(read-modify-write, atomic rename; other keys are preserved).

Deterministic: fixed RNG seed, fixed hints, no randomness.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.dirname(HERE)
ASSETS = os.path.join(GAME, "assets")
CHARS = os.path.join(ASSETS, "chars")
MANIFEST = os.path.join(ASSETS, "manifest.json")
DEFAULT_PDF = "/root/.claude/uploads/b9ac1d4a-b524-5cd9-8270-6501b1ec2bef/a3b67d45-MousieBook1.jpg.pdf"

MAX_SIDE = 900
MARGIN = 6
AUTHOR = "Samar (age 6)"
LICENSE = "Family artwork, all rights reserved"

# --------------------------------------------------------------------------
# Cutout specs.  All coordinates are 300-dpi page pixels (2550 x 3300).
# fg / keep entries: (width, [points])  -> polyline of that width
#                    (0, [points])      -> filled polygon
# --------------------------------------------------------------------------
SPECS = {}


def spec(name, **kw):
    SPECS[name] = kw


# Mousie on the cover: walking right on the path, plain background.
spec("mousie", page=1, facing="right", title="Mousie walking (cover)",
     outer=[(478, 1262), (540, 1150), (650, 1085), (760, 1070), (930, 1035), (1060, 1045),
            (1100, 1150), (1170, 1215), (1300, 1255), (1302, 1650), (1220, 1830), (1130, 1905),
            (1000, 1945), (800, 1985), (610, 1990), (560, 1900), (570, 1800), (500, 1710),
            (478, 1500)],
     fg=[(0, [(800, 1200), (1000, 1200), (1150, 1290), (1000, 1380), (800, 1400)]),
         (0, [(780, 1420), (980, 1440), (1010, 1600), (980, 1760), (800, 1790), (760, 1600)]),
         (12, [(690, 1850), (680, 1920)]), (10, [(965, 1820), (990, 1890), (1060, 1830)]),
         (20, [(720, 1180)]), (20, [(998, 1080)])],
     bg=[(0, [(745, 1868), (940, 1858), (965, 1965), (735, 1975)]),
         (0, [(1040, 1690), (1200, 1650), (1180, 1760), (1070, 1770)]),
         (8, [(700, 1340), (705, 1455)])],
     hole_max=1500)

# Daddy, top panel of page 2: big mouse facing left, forest background.
spec("daddy", page=2, facing="left", title="Daddy mouse",
     outer=[(1278, 680), (1440, 560), (1480, 330), (1620, 300), (1740, 320), (1980, 320),
            (2000, 520), (2100, 530), (2160, 535), (2180, 600), (2195, 1000), (2190, 1150),
            (2160, 1240), (2060, 1290), (2030, 1420), (1960, 1460), (1925, 1522), (1810, 1522),
            (1795, 1480), (1495, 1518), (1480, 1400), (1470, 1150), (1370, 1120), (1360, 980),
            (1420, 880), (1440, 800), (1300, 830), (1278, 760)],
     patch=[((0, [(2104, 1198), (2138, 1196), (2128, 1252), (2098, 1256)]), (226, 178, 160))],
     fg=[(0, [(1560, 640), (1700, 560), (1840, 640), (1900, 900), (1980, 1250), (1900, 1400),
              (1650, 1420), (1580, 1200), (1560, 900)]),
         (0, [(1470, 700), (1560, 640), (1600, 780), (1500, 760)]),
         (20, [(1545, 420), (1550, 520)]), (30, [(1840, 420), (1880, 480)]),
         (7, [(2140, 556), (2054, 595), (2026, 671), (2021, 766), (2040, 842), (2073, 899),
              (2107, 975), (2126, 1051), (2130, 1117), (2116, 1165), (2092, 1193)]),
         (10, [(2110, 1240), (2060, 1275), (1990, 1295)]),
         (14, [(1410, 1060), (1440, 1010), (1480, 960)]),
         (10, [(1540, 1452), (1600, 1450), (1680, 1432)]), (14, [(1830, 1480), (1900, 1470)])],
     bg=[(0, [(1855, 590), (2002, 590), (1998, 700), (2005, 800), (2025, 880), (1960, 895),
              (1932, 850), (1898, 790), (1858, 740)]),
         (0, [(2008, 1100), (2095, 1100), (2095, 1170), (2075, 1222), (2040, 1240), (2008, 1245)]),
         (0, [(2002, 1322), (2100, 1290), (2110, 1420), (2002, 1420)]),
         (10, [(2085, 640), (2075, 760), (2110, 870), (2165, 980), (2185, 1100)]),
         (0, [(1455, 935), (1500, 930), (1495, 952), (1462, 966)]),
         (6, [(1572, 1022), (1572, 1100)]),
         (0, [(1590, 1482), (1700, 1468), (1700, 1500), (1590, 1500)]),
         (0, [(1300, 830), (1420, 800), (1400, 870), (1300, 900)])],
     bg_over=[(0, [(1400, 995), (1420, 998), (1460, 978), (1500, 953), (1535, 931), (1525, 900),
                   (1400, 900)]),
              (0, [(1703, 1386), (1760, 1384), (1830, 1398), (1832, 1440), (1703, 1440)]),
              (0, [(1525, 1484), (1560, 1482), (1600, 1474), (1650, 1466), (1700, 1450), (1740, 1442),
                   (1745, 1520), (1525, 1520)])],
     cut=[(0, [(1912, 1490), (1945, 1486), (1945, 1525), (1912, 1525)]),
          (0, [(2172, 1092), (2205, 1092), (2205, 1132), (2172, 1132)]),
          (0, [(2080, 1120), (2113, 1128), (2108, 1175), (2096, 1196), (2080, 1196)])],
     inpaint=[(0, [(1912, 1345), (1943, 1306), (1977, 1306), (1993, 1330), (1990, 1372),
                   (1972, 1396), (1938, 1396), (1914, 1372)])],
     lines=[(0, [(1278, 680), (1420, 690), (1440, 720), (1435, 790), (1360, 830), (1278, 830)])],
     kill_hue=[(28, 95, 45)],
     line_thresh=125, line_min=150, line_len=50, hole_max=1500)

# Birdie walking next to Mousie, page 3 middle panel: standing side view facing right.
spec("birdie", page=3, facing="right", title="Birdie",
     outer=[(1280, 1540), (1320, 1515), (1385, 1585), (1560, 1480), (1650, 1390), (1760, 1390),
            (1810, 1450), (1870, 1500), (1810, 1535), (1800, 1600), (1770, 1800), (1700, 1860),
            (1790, 1885), (1795, 1945), (1700, 1945), (1600, 1880), (1530, 1900), (1565, 1975),
            (1425, 1980), (1470, 1900), (1460, 1830), (1380, 1795), (1300, 1720), (1268, 1620)],
     fg=[(0, [(1640, 1530), (1740, 1460), (1770, 1600), (1720, 1770), (1550, 1800), (1480, 1720),
              (1560, 1630)]),
         (10, [(1310, 1575), (1430, 1680)]),
         (5, [(1520, 1840), (1490, 1940)]), (5, [(1650, 1860), (1700, 1915)])],
     bg=[(8, [(1395, 1535), (1440, 1570)])],
     kill_hue=[(25, 90, 40)],
     hole_max=600)

# Birdie flying with the arrows, page 4 middle-right panel.
spec("birdie-fly", page=4, facing="right", title="Birdie flying with arrows", flying=True,
     outer=[(1410, 1660), (1500, 1610), (1500, 1450), (1530, 1280), (1600, 1300), (1700, 1360),
            (1740, 1360), (1800, 1380), (1815, 1500), (1880, 1500), (1950, 1520), (1978, 1585),
            (2040, 1600), (2130, 1640), (2120, 1760), (2040, 1850), (1950, 1910), (1860, 1890),
            (1830, 1900), (1760, 1910), (1690, 1910), (1620, 1830), (1540, 1760), (1430, 1720)],
     fg=[(0, [(1650, 1600), (1850, 1600), (1900, 1680), (1800, 1780), (1680, 1760), (1620, 1700)]),
         (0, [(1580, 1380), (1650, 1450), (1700, 1600), (1620, 1600)]),
         (0, [(1830, 1560), (1920, 1560), (1940, 1620), (1880, 1650), (1820, 1640)]),
         (6, [(1685, 1805), (1710, 1845), (1730, 1890)]), (6, [(1740, 1810), (1770, 1845), (1800, 1880)])],
     bg=[(8, [(1470, 1430), (1500, 1530)]),
         (0, [(1798, 1340), (1900, 1340), (1900, 1468), (1845, 1462), (1814, 1438), (1797, 1372)])],
     keep=[(0, [(1768, 1376), (1782, 1388), (1796, 1408), (1806, 1440), (1822, 1470), (1832, 1500),
                (1832, 1540), (1790, 1565), (1760, 1575), (1735, 1550), (1722, 1500), (1726, 1477),
                (1738, 1482), (1734, 1440), (1744, 1419), (1755, 1432), (1758, 1400)])],
     kill_hue=[(28, 95, 35)],
     hole_max=600)

# The defeated Velociraptor, page 4 bottom panel.  Birdie (standing on its back), the
# arrows stuck in its tail and the arrow on the ground are removed.
spec("raptor-dead", page=4, facing="left", title="Velociraptor (defeated)",
     outer=[(380, 2950), (395, 2860), (450, 2755), (500, 2685), (570, 2680), (700, 2760),
            (800, 2742), (950, 2648), (1100, 2625), (1300, 2575), (1450, 2475), (1550, 2432),
            (1650, 2432), (1725, 2455), (1715, 2495), (1600, 2495), (1500, 2535), (1420, 2625),
            (1340, 2720), (1300, 2800), (1400, 2835), (1500, 2915), (1580, 2985), (1540, 3020),
            (1450, 3045), (1300, 3050), (1100, 3070), (1050, 3090), (760, 3090), (700, 3030),
            (560, 3010), (440, 3000)],
     fg=[(0, [(450, 2850), (520, 2760), (620, 2800), (560, 2900), (470, 2930)]),
         (0, [(480, 2960), (520, 2880), (580, 2840), (560, 2920), (520, 2980)]),
         (0, [(650, 2830), (800, 2800), (1000, 2720), (1200, 2700), (1250, 2800), (1100, 2900),
              (800, 2900)]),
         (10, [(1250, 2680), (1350, 2600), (1450, 2530), (1550, 2480), (1650, 2462)]),
         (8, [(1260, 2860), (1380, 2900), (1480, 2960), (1530, 2985)])],
     bg=[(0, [(560, 2600), (740, 2600), (740, 2740), (690, 2750), (600, 2700)]),
         (0, [(1350, 2730), (1420, 2640), (1520, 2560), (1700, 2520), (1700, 2830), (1420, 2830)])],
     clone=[((0, [(905, 2668), (998, 2655), (1008, 2752), (938, 2758), (905, 2705)]), 0, 75),
            ((0, [(985, 2655), (1078, 2650), (1078, 2720), (1025, 2722)]), 0, 75)],
     cut=[(0, [(745, 2330), (1280, 2330), (1280, 2598), (1190, 2626), (1120, 2636), (1040, 2642),
               (1000, 2648), (960, 2656), (920, 2668), (880, 2688), (840, 2718), (800, 2745),
               (745, 2745)]),
          (22, [(1340, 2360), (1428, 2484)]), (22, [(1468, 2330), (1477, 2462)]),
          (0, [(505, 3038), (722, 2982), (748, 2988), (742, 3008), (560, 3075), (505, 3075)])],
     grow_dark=(60, 12), ink_cut=6, ink_cut_n=1, hole_max=800)

# T-Rex knocked over by the BOOM, page 5 bottom panel: full body, X eye, facing right.
spec("trex-dead", page=5, facing="right", title="T-Rex knocked out by the BOOM",
     outer=[(1440, 2460), (1530, 2455), (1560, 2490), (1440, 2492), (1410, 2503), (1390, 2527),
            (1385, 2570), (1395, 2608), (1428, 2636), (1474, 2652), (1560, 2720), (1630, 2715), (1620, 2620), (1660, 2540), (1720, 2470), (1780, 2475),
            (1860, 2560), (1905, 2650), (1895, 2800), (1815, 2870), (1775, 2965), (1700, 2955),
            (1660, 2930), (1600, 2940), (1560, 2945), (1535, 2990), (1600, 3035), (1608, 3055),
            (1607, 3074), (1586, 3084), (1525, 3084), (1488, 3078), (1468, 3060), (1460, 3040), (1440, 3020), (1385, 2965), (1365, 2975), (1345, 2988), (1305, 2988),
            (1272, 2982), (1262, 2965), (1280, 2955), (1258, 2950), (1250, 2930), (1266, 2914),
            (1292, 2906), (1312, 2888), (1322, 2873), (1328, 2858), (1334, 2843), (1348, 2835),
            (1366, 2830), (1356, 2815), (1350, 2800), (1344, 2785), (1336, 2770), (1329, 2755),
            (1320, 2740), (1312, 2725), (1304, 2710), (1296, 2695), (1291, 2680), (1286, 2665),
            (1283, 2650), (1282, 2628), (1284, 2605), (1287, 2590), (1292, 2575), (1299, 2560),
            (1309, 2545), (1321, 2530), (1338, 2515), (1355, 2506), (1400, 2484)],
     fg=[(0, [(1350, 2700), (1550, 2790), (1660, 2800), (1745, 2750), (1720, 2620), (1790, 2560),
              (1850, 2660), (1800, 2800), (1600, 2880), (1400, 2900), (1378, 2800)]),
         (14, [(1385, 2650), (1328, 2572), (1358, 2518), (1450, 2490)]),
         (14, [(1480, 2900), (1500, 3000), (1560, 3060)]), (10, [(1348, 2872), (1322, 2945)]),
         (12, [(1326, 2548), (1301, 2600), (1298, 2650), (1306, 2700), (1352, 2775)]),
         (0, [(1675, 2770), (1745, 2790), (1725, 2865), (1665, 2865)])],
     bg=[(0, [(1420, 2520), (1540, 2500), (1590, 2610), (1615, 2705), (1560, 2705), (1450, 2610)]),
         ],
     kill_hue=[(0, 179, 40, 196)],
     protect=[(0, [(1640, 2490), (1770, 2490), (1790, 2720), (1660, 2720), (1600, 2640)])],
     grow_dark=(90, 14), hole_max=600)

# T-Rex roaring, page 5 top panel.  The art stops at the panel's bottom edge (no legs);
# Birdie (front left), Mousie (front right), the ROOR! bubble and the caption are removed.
spec("trex-roar", page=5, facing="right", title="T-Rex roaring",
     outer=[(715, 468), (765, 486), (700, 508), (652, 542), (634, 580), (648, 612), (700, 626),
            (778, 608), (815, 572), (895, 490), (955, 460), (995, 430), (1045, 390), (1100, 375),
            (1118, 366), (1124, 326), (1150, 312), (1200, 320), (1255, 300), (1300, 290),
            (1380, 295), (1440, 312), (1495, 338), (1525, 375), (1580, 445), (1640, 520),
            (1680, 700), (1680, 1210), (900, 1210), (830, 1170), (790, 1120), (770, 1000),
            (730, 870), (705, 835), (600, 810), (548, 720), (548, 620), (590, 520), (650, 480)],
     fg=[(0, [(900, 650), (1050, 500), (1300, 420), (1500, 600), (1450, 900), (1350, 1050),
              (1100, 1080), (900, 1000)]),
         (0, [(1500, 1000), (1580, 1050), (1600, 1150), (1520, 1150)]),
         (12, [(690, 492), (612, 560), (585, 680), (640, 780), (740, 815)])],
     bg=[(0, [(655, 580), (700, 545), (790, 540), (800, 590), (720, 612), (668, 605)])],
     cut=[(0, [(1525, 360), (1700, 360), (1700, 1260), (1630, 1260), (1608, 1150), (1580, 1060),
               (1555, 1000), (1560, 950), (1585, 880), (1597, 800), (1593, 700), (1600, 600),
               (1590, 500), (1560, 430)]),
          (0, [(500, 850), (705, 850), (762, 895), (790, 920), (802, 945), (795, 968), (778, 990), (775, 1260), (500, 1260)]),
          (0, [(500, 1199), (1800, 1199), (1800, 1260), (500, 1260)])],
     kill_hue=[(55, 95, 38, 180)],
     protect=[(0, [(560, 450), (1550, 300), (1600, 1000), (560, 1000)]),
              (0, [(760, 1000), (950, 1000), (930, 1198), (760, 1198)])],
     clone=[((0, [(796, 928), (842, 938), (845, 960), (830, 980), (790, 985)]), 0, -70)],
     ink_cut=5, ink_cut_n=2, hole_max=1500)

# Snake, page 6 bottom panel (big, coiled, head to the left).  The "Hehe" bubble is
# outside the hint polygon; the ground seen through the coil stays transparent.
spec("snake", page=6, facing="left", title="Snake",
     outer=[(1600, 2700), (1640, 2630), (1700, 2590), (1770, 2600), (1800, 2650), (1790, 2720),
            (1780, 2800), (1770, 2880), (1850, 2860), (1920, 2880), (1950, 2930), (1955, 2990), (1930, 3030),
            (1900, 3060), (1750, 3060), (1600, 3040), (1530, 3010), (1500, 2950), (1510, 2860),
            (1505, 2785), (1545, 2780), (1590, 2770), (1590, 2740)],
     fg=[(0, [(1640, 2640), (1700, 2620), (1720, 2670), (1680, 2700), (1630, 2680)]),
         (16, [(1730, 2700), (1700, 2800), (1680, 2900), (1700, 2990), (1800, 3020), (1890, 3000),
               (1905, 2950), (1880, 2915), (1800, 2900)]),
         (12, [(1555, 2790), (1560, 2860), (1555, 2950), (1600, 3000), (1660, 3000)]),
         (3, [(1605, 2712), (1598, 2738)])],
     bg=[(0, [(1770, 2932), (1820, 2928), (1850, 2940), (1835, 2955), (1790, 2958), (1768, 2948)]),
         (0, [(1928, 2903), (1970, 2900), (1970, 3060), (1915, 3060), (1913, 3028), (1922, 3006),
              (1929, 2991), (1934, 2978), (1938, 2955), (1937, 2930)])],
     kill_hue=[(33, 95, 40)],
     grow_dark=(80, 8), hole_max=300)

# Lion standing, page 6 second row left: facing left (head on the left, tail on the right).
spec("lion", page=6, facing="left", title="Lion",
     outer=[(810, 1060), (860, 960), (930, 900), (1000, 890), (1060, 920), (1110, 955),
            (1150, 1030), (1160, 1060), (1158, 1000), (1185, 975), (1205, 965), (1222, 1010),
            (1220, 1060), (1212, 1075), (1240, 1115), (1250, 1150), (1248, 1185), (1222, 1208),
            (1205, 1228), (1205, 1300), (1215, 1360), (1205, 1402), (1110, 1402), (1050, 1395),
            (990, 1402), (880, 1404), (870, 1300), (835, 1260), (815, 1180)],
     fg=[(0, [(900, 1000), (1040, 960), (1090, 1100), (1140, 1200), (1170, 1280), (1100, 1290),
              (1000, 1285), (930, 1280), (900, 1260), (860, 1150)]),
         (14, [(910, 1290), (905, 1380)]), (14, [(1015, 1290), (1015, 1385)]),
         (12, [(1085, 1300), (1085, 1360)]), (14, [(1170, 1290), (1175, 1375)]),
         (6, [(1190, 995), (1188, 1040), (1186, 1062), (1189, 1085), (1205, 1105), (1225, 1125),
              (1236, 1150), (1234, 1173), (1215, 1190), (1185, 1196), (1160, 1190)])],
     bg=[(6, [(1155, 1075), (1168, 1105), (1193, 1130), (1208, 1150), (1200, 1166), (1178, 1172)]),
         (6, [(1222, 1080), (1240, 1100)]),
         (0, [(1140, 990), (1160, 990), (1158, 1050), (1145, 1050)]),
         (0, [(948, 1300), (975, 1290), (985, 1330), (980, 1370), (955, 1365)]),
         (0, [(1053, 1322), (1064, 1320), (1066, 1358), (1056, 1362)]),
         (0, [(1112, 1300), (1138, 1300), (1140, 1345), (1117, 1358)]),
         (0, [(1210, 1215), (1250, 1215), (1250, 1400), (1215, 1400), (1210, 1300)])],
     kill_hue=[(33, 95, 40)],
     hole_max=300)

# Lion running away (ZOOOM), page 6 second row right: facing right.
spec("lion-run", page=6, facing="right", title="Lion running",
     outer=[(1640, 1010), (1690, 1015), (1692, 1088), (1716, 1124), (1745, 1134), (1775, 1128),
            (1805, 1112), (1840, 1094), (1900, 1080), (2000, 1060), (2010, 940), (2100, 920), (2200, 920), (2270, 950),
            (2300, 1020), (2310, 1080), (2300, 1150), (2340, 1190), (2350, 1260), (2320, 1290),
            (2270, 1290), (2230, 1330), (2160, 1330), (2050, 1290), (1980, 1250), (1910, 1290),
            (1800, 1300), (1720, 1300), (1700, 1240), (1720, 1170), (1660, 1140), (1645, 1080)],
     fg=[(0, [(1850, 1150), (2050, 1100), (2120, 960), (2250, 1000), (2260, 1150), (2250, 1250),
              (2100, 1260), (1950, 1220), (1820, 1220)]),
         (5, [(1667, 1085), (1670, 1110), (1685, 1130), (1710, 1145), (1740, 1150), (1770, 1145),
              (1800, 1132), (1830, 1118)])],
     bg_over=[(0, [(2268, 1140), (2275, 1212), (2208, 1212), (2218, 1195), (2240, 1170),
                   (2256, 1150)]),
              (0, [(2206, 1197), (2262, 1197), (2262, 1218), (2232, 1212), (2212, 1206)]),
              (0, [(2124, 1253), (2170, 1254), (2158, 1262), (2128, 1262)])],
     kill_hue=[(33, 95, 35)],
     lines=[(0, [(2262, 1060), (2300, 1060), (2300, 1125), (2262, 1125)])],
     line_thresh=110, line_min=40, line_len=15,
     hole_max=800)

# Fire truck, page 6 third row right (driving right, siren rays and smoke excluded).
spec("firetruck", page=6, facing="right", title="Fire truck",
     outer=[(1630, 1730), (1720, 1700), (1760, 1680), (1880, 1690), (1900, 1655), (1960, 1655),
            (1975, 1690), (2040, 1700), (2055, 1745), (2080, 1755), (2085, 1800), (2130, 1830),
            (2160, 1900), (2140, 1950), (2110, 1975), (2050, 1975), (1990, 1960), (1940, 1990),
            (1860, 1995), (1810, 1940), (1720, 1930), (1680, 1925), (1640, 1880), (1620, 1860),
            (1625, 1800)],
     fg=[(0, [(1680, 1760), (1900, 1720), (2030, 1730), (2100, 1880), (2000, 1930), (1800, 1900),
              (1690, 1860)]),
         (0, [(2084, 1836), (2096, 1824), (2112, 1824), (2126, 1836), (2138, 1860), (2146, 1895),
              (2086, 1900), (2082, 1860)]),
         (5, [(2044, 1752), (2050, 1745), (2057, 1752), (2052, 1762), (2044, 1770), (2044, 1786)])],
     bg_over=[(0, [(2018, 1722), (2040, 1722), (2040, 1742), (2038, 1766), (2026, 1768), (2020, 1745)]),
              (0, [(2050, 1773), (2068, 1770), (2076, 1798), (2060, 1797), (2052, 1788)])],
     kill_hue=[(28, 100, 30)],
     protect=[(0, [(2040, 1740), (2062, 1740), (2062, 1768), (2040, 1768)])],
     hole_max=1500)

SPECS_ORDER = ["mousie", "daddy", "birdie", "birdie-fly", "raptor-dead", "trex-roar", "trex-dead",
               "snake", "lion", "lion-run", "firetruck"]


# --------------------------------------------------------------------------
def render_pages(pdf, outdir):
    os.makedirs(outdir, exist_ok=True)
    need = [i for i in range(1, 8) if not os.path.exists(os.path.join(outdir, f"p-{i}.png"))]
    if need:
        # Only pages 1..7; page 8 (author photo) is deliberately excluded.
        subprocess.run(["pdftoppm", "-r", "300", "-png", "-f", "1", "-l", "7", pdf,
                        os.path.join(outdir, "p")], check=True)
    pages = {}
    for i in range(1, 8):
        p = os.path.join(outdir, f"p-{i}.png")
        if not os.path.exists(p):  # pdftoppm may zero-pad
            p = os.path.join(outdir, f"p-{i:02d}.png")
        pages[i] = p
    return pages


def _pts(points, ox, oy):
    return np.array([[x - ox, y - oy] for x, y in points], np.int32)


def paint(mask, items, value, ox, oy):
    for w, pts in items:
        a = _pts(pts, ox, oy)
        if w == 0:
            cv2.fillPoly(mask, [a], value)
        else:
            cv2.polylines(mask, [a], False, value, thickness=w, lineType=cv2.LINE_8)
            for p in a:
                cv2.circle(mask, tuple(int(v) for v in p), w // 2, value, -1)


def fill_small_holes(m, hole_max):
    inv = (m == 0).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    h, w = m.shape
    out = m.copy()
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        touches = x == 0 or y == 0 or x + bw >= w or y + bh >= h
        if not touches and area <= hole_max:
            out[lab == i] = 1
    return out


def cut_one(name, s, pages, debug_dir=None):
    page = cv2.imread(pages[s["page"]], cv2.IMREAD_COLOR)
    outer = s["outer"]
    xs = [p[0] for p in outer]
    ys = [p[1] for p in outer]
    pad = 20
    x0, y0 = max(min(xs) - pad, 0), max(min(ys) - pad, 0)
    x1, y1 = min(max(xs) + pad, page.shape[1]), min(max(ys) + pad, page.shape[0])
    img = page[y0:y1, x0:x1].copy()
    h, w = img.shape[:2]

    if s.get("inpaint"):
        # paint over small occluders (e.g. a flower in front of a leg) from surrounding fur
        ip = np.zeros((h, w), np.uint8)
        paint(ip, s["inpaint"], 255, x0, y0)
        img = cv2.inpaint(img, ip, 15, cv2.INPAINT_TELEA)

    for poly, dx, dy in s.get("clone", []):
        # cover an occluder with texture copied from (dx, dy) away on the same character
        cm_ = np.zeros((h, w), np.uint8)
        paint(cm_, [poly], 1, x0, y0)
        src = np.roll(np.roll(img, -dy, axis=0), -dx, axis=1)
        soft = cv2.GaussianBlur(cm_.astype(np.float32), (0, 0), 2)[..., None]
        img = (img * (1 - soft) + src * soft).astype(np.uint8)

    patch = np.zeros((h, w), np.uint8)
    for poly, rgb in s.get("patch", []):
        # recolour an occluder lying across a thin part (leaf over a tail) in the part's
        # colour, keeping its shading, and force it into the mask
        pm = np.zeros((h, w), np.uint8)
        paint(pm, [poly], 1, x0, y0)
        lum = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
        ref = float(np.dot(rgb, [0.299, 0.587, 0.114]))
        k = np.clip(lum / max(np.percentile(lum[pm > 0], 85), 1), 0, 1.1)[..., None]
        col = np.clip(np.array(rgb[::-1], np.float32)[None, None, :] * k, 0, 255).astype(np.uint8)
        img[pm > 0] = col[pm > 0]
        patch |= pm

    gc = np.full((h, w), cv2.GC_BGD, np.uint8)
    cv2.fillPoly(gc, [_pts(outer, x0, y0)], cv2.GC_PR_FGD)
    paint(gc, s.get("prbg", []), cv2.GC_PR_BGD, x0, y0)
    paint(gc, s.get("bg", []), cv2.GC_BGD, x0, y0)
    paint(gc, s.get("fg", []), cv2.GC_FGD, x0, y0)
    paint(gc, s.get("bg_over", []), cv2.GC_BGD, x0, y0)  # background that wins over fg hints
    seeds = (gc == cv2.GC_FGD).astype(np.uint8)

    cv2.setRNGSeed(12345)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(img, gc, None, bgd, fgd, s.get("iters", 8), cv2.GC_INIT_WITH_MASK)
    m = ((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD)).astype(np.uint8)

    if s.get("kill_hue"):
        # drop leftover background of a colour the character does not have
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        H, S_, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
        prot = np.zeros_like(m)
        paint(prot, s.get("protect", []), 1, x0, y0)
        prot[seeds > 0] = 1
        for rule in s["kill_hue"]:
            lo, hi, smin = rule[:3]
            vmin = rule[3] if len(rule) > 3 else 70
            kill = (H >= lo) & (H <= hi) & (S_ >= smin) & (V >= vmin) & (prot == 0)
            m[kill] = 0
    if s.get("cut"):
        cm = np.zeros_like(m)
        paint(cm, s["cut"], 1, x0, y0)
        m[cm > 0] = 0
    k = s.get("open", 3)
    if k:
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    k = s.get("close", 5)
    if k:
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    if s.get("grow_dark"):
        # re-attach the black ink outline: grow into very dark pixels next to the mask
        thr, iters = s["grow_dark"]
        dark = (cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) < thr).astype(np.uint8)
        allowed = np.zeros_like(m)
        cv2.fillPoly(allowed, [_pts(outer, x0, y0)], 1)
        if s.get("cut"):
            allowed[cm > 0] = 0
        bgm = np.zeros_like(m)
        paint(bgm, s.get("bg", []) + s.get("bg_over", []), 1, x0, y0)
        allowed[bgm > 0] = 0
        k3 = np.ones((3, 3), np.uint8)
        for _ in range(iters):
            m = np.maximum(m, cv2.dilate(m, k3) & dark & allowed)
    if s.get("keep"):
        paint(m, s["keep"], 1, x0, y0)
    m[patch > 0] = 1
    if s.get("cut"):
        m[cm > 0] = 0

    # keep components that hold a seed, or that are big relative to the largest
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n > 1:
        big = stats[1:, cv2.CC_STAT_AREA].max()
        keep = np.zeros(n, bool)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= s.get("min_frac", 0.2) * big:
                keep[i] = True
        for i in np.unique(lab[seeds > 0]):
            if i:
                keep[i] = True
        m = keep[lab].astype(np.uint8)
    m = fill_small_holes(m, s.get("hole_max", 800))
    if s.get("lines"):
        # thin dark strokes (whiskers) inside the given region, if connected to the body
        reg = np.zeros_like(m)
        paint(reg, s["lines"], 1, x0, y0)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        dark = ((gray < s.get("line_thresh", 80)) & (reg > 0)).astype(np.uint8)
        m_before = m.copy()
        nn, ll, st, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
        for i in range(1, nn):
            if (st[i, cv2.CC_STAT_AREA] >= s.get("line_min", 120)
                    and max(st[i, cv2.CC_STAT_WIDTH], st[i, cv2.CC_STAT_HEIGHT]) >= s.get("line_len", 40)):
                li = cv2.dilate((ll == i).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
                img[li & (m_before == 0)] = (34, 30, 30)
                m[li] = 1  # paint the stroke in ink so it carries no background tint

    if s.get("ink_cut") and s.get("cut"):
        # draw an ink line where an occluder was cut away, so the edge matches the art
        cm2 = np.zeros_like(m)
        paint(cm2, s["cut"][:s.get("ink_cut_n", len(s["cut"]))], 1, x0, y0)
        near = cv2.dilate(cm2, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * s["ink_cut"] + 1,) * 2))
        edge = (near > 0) & (m > 0)
        img[edge] = (img[edge] * 0.15 + np.array([40, 38, 35]) * 0.85).astype(np.uint8)

    # feather: shave 1 px of fringe, then soften the edge ~1.5 px
    m = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    alpha = cv2.GaussianBlur(m.astype(np.float32), (0, 0), s.get("feather", 1.0))
    alpha = np.clip((alpha - 0.5) * 2 + 0.5, 0, 1) if s.get("hard") else alpha
    a8 = (alpha * 255 + 0.5).astype(np.uint8)

    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    rgba = np.dstack([rgb, a8])
    ys_, xs_ = np.nonzero(a8 > 8)
    bx0, by0, bx1, by1 = xs_.min(), ys_.min(), xs_.max() + 1, ys_.max() + 1
    rgba = rgba[by0:by1, bx0:bx1]
    im = Image.fromarray(rgba, "RGBA")
    sc = min(1.0, (MAX_SIDE - 2 * MARGIN) / max(im.size))
    if sc < 1.0:
        # premultiply to avoid dark/colored halos when resampling
        arr = np.asarray(im).astype(np.float32)
        arr[..., :3] *= arr[..., 3:4] / 255.0
        pim = Image.fromarray(arr.round().astype(np.uint8), "RGBA")
        nw, nh = max(1, round(im.width * sc)), max(1, round(im.height * sc))
        pim = pim.resize((nw, nh), Image.LANCZOS)
        arr = np.asarray(pim).astype(np.float32)
        a = arr[..., 3:4]
        arr[..., :3] = np.where(a > 0, arr[..., :3] * 255.0 / np.maximum(a, 1), 0)
        im = Image.fromarray(np.clip(arr, 0, 255).round().astype(np.uint8), "RGBA")
    canvas = Image.new("RGBA", (im.width + 2 * MARGIN, im.height + 2 * MARGIN), (0, 0, 0, 0))
    canvas.paste(im, (MARGIN, MARGIN))
    # zero RGB where fully transparent (smaller files, no stray colour)
    arr = np.asarray(canvas).copy()
    arr[arr[..., 3] == 0, :3] = 0
    canvas = Image.fromarray(arr, "RGBA")

    A = arr[..., 3]
    rows = np.nonzero((A > 128).sum(axis=1) >= max(3, int(0.02 * canvas.width)))[0]
    feet = 0.5 if s.get("flying") else round(float(rows.max() + 1) / canvas.height, 3)

    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)
        dbg = img.copy()
        ov = dbg.copy()
        ov[seeds > 0] = (0, 255, 0)
        cv2.polylines(ov, [_pts(outer, x0, y0)], True, (255, 0, 255), 3)
        dbg = cv2.addWeighted(dbg, 0.6, ov, 0.4, 0)
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(dbg, cnts, -1, (0, 0, 255), 2)
        cv2.imwrite(os.path.join(debug_dir, f"{name}-hints.jpg"), dbg)
        # full-res mask on magenta with a 50 px page-coordinate grid
        g = img.copy()
        g[m == 0] = (255, 0, 255)
        for gx in range((x0 // 50 + 1) * 50, x1, 50):
            cv2.line(g, (gx - x0, 0), (gx - x0, h), (0, 255, 255) if gx % 100 == 0 else (0, 140, 140), 1)
            if gx % 100 == 0:
                cv2.putText(g, str(gx), (gx - x0 + 2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)
        for gy in range((y0 // 50 + 1) * 50, y1, 50):
            cv2.line(g, (0, gy - y0), (w, gy - y0), (255, 255, 0) if gy % 100 == 0 else (140, 140, 0), 1)
            if gy % 100 == 0:
                cv2.putText(g, str(gy), (2, gy - y0 - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)
        cv2.imwrite(os.path.join(debug_dir, f"{name}-grid.png"), g)
        mag = Image.new("RGBA", canvas.size, (255, 0, 255, 255))
        mag.alpha_composite(canvas)
        mag.convert("RGB").save(os.path.join(debug_dir, f"{name}-mag.png"))
    return canvas, feet


def merge_manifest(chars):
    os.makedirs(ASSETS, exist_ok=True)
    data = {}
    if os.path.exists(MANIFEST):
        with open(MANIFEST) as f:
            data = json.load(f)
    data["characters"] = chars
    fd, tmp = tempfile.mkstemp(prefix=".manifest-", suffix=".json", dir=ASSETS)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, MANIFEST)


# key -> (base spec name or None, {pose: spec name})
CHARACTERS = {
    "mousie": ("mousie", {}),
    "daddy": ("daddy", {}),
    "birdie": ("birdie", {"fly": "birdie-fly"}),
    "raptor": (None, {"dead": "raptor-dead"}),  # the book never shows it standing
    "trex": ("trex-roar", {"roar": "trex-roar", "dead": "trex-dead"}),
    "snake": ("snake", {}),
    "lion": ("lion", {"run": "lion-run"}),
    "firetruck": ("firetruck", {}),
}

CREDIT_TITLES = {
    "birdie": "Birdie (standing p3; flying with arrows p4)",
    "trex": "T-Rex roaring (p5 top); knocked out by the BOOM (p5 bottom)",
    "lion": "Lion standing and running away",
}


def contact_sheet(names, path):
    """All cutouts on mid-grey (top half) and dark green (bottom half), labelled."""
    from PIL import ImageDraw
    cell = 300
    cols = 4
    rows = (len(names) + cols - 1) // cols
    W, H = cols * cell, rows * (cell + 20)
    sheet = Image.new("RGB", (W, 2 * H), (0, 0, 0))
    for half, bgc in enumerate([(128, 128, 128), (24, 70, 32)]):
        sheet.paste(Image.new("RGB", (W, H), bgc), (0, half * H))
        d = ImageDraw.Draw(sheet)
        for i, n in enumerate(names):
            im = Image.open(os.path.join(CHARS, f"{n}.png"))
            sc = min((cell - 16) / im.width, (cell - 16) / im.height)
            im = im.resize((max(1, int(im.width * sc)), max(1, int(im.height * sc))), Image.LANCZOS)
            cx, cy = (i % cols) * cell, half * H + (i // cols) * (cell + 20)
            sheet.paste(im, (cx + (cell - im.width) // 2, cy + 20 + (cell - im.height) // 2), im)
            d.text((cx + 6, cy + 4), n, fill=(255, 255, 255))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sheet.save(path)


def output_names():
    """spec name -> list of published file stems (chars/<key>.png, chars/<key>-<pose>.png)."""
    out = {}
    for key, (base, poses) in CHARACTERS.items():
        if base:
            out.setdefault(base, []).append(key)
        for pose, n in poses.items():
            out.setdefault(n, []).append(f"{key}-{pose}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default=DEFAULT_PDF)
    ap.add_argument("--pages", default=os.environ.get("MOUSIE_PAGES", "/tmp/mousie-pages"))
    ap.add_argument("--debug", help="write hint overlays / magenta previews here")
    ap.add_argument("--only", help="comma-separated spec names; skips the manifest")
    ap.add_argument("--sheet", help="also write a review contact sheet PNG here")
    args = ap.parse_args()
    pages = render_pages(args.pdf, args.pages)
    os.makedirs(CHARS, exist_ok=True)
    only = set(args.only.split(",")) if args.only else None
    outs = output_names()

    results = {}
    for name in SPECS_ORDER:
        if only and name not in only:
            continue
        s = SPECS[name]
        canvas, feet = cut_one(name, s, pages, args.debug)
        for stem in outs[name]:
            canvas.save(os.path.join(CHARS, f"{stem}.png"), optimize=True)
        results[name] = (canvas.size, feet)
        print(f"{name:12s} -> {', '.join(outs[name]):18s} p{s['page']} "
              f"{canvas.width}x{canvas.height} feet={feet} facing={s['facing']}")

    if args.sheet:
        contact_sheet([outs[n][0] for n in SPECS_ORDER if n in results], args.sheet)
    if only:
        return
    chars = {}
    for key, (base, poses) in CHARACTERS.items():
        entry = {}
        first = base or next(iter(poses.values()))
        if base:
            (w, h), feet = results[base]
            entry.update(file=f"chars/{key}.png", w=w, h=h, facing=SPECS[base]["facing"], feet=feet)
        entry["credit"] = {
            "title": CREDIT_TITLES.get(key, SPECS[first]["title"]), "author": AUTHOR,
            "license": LICENSE, "licenseUrl": "",
            "source": "Mousie, Part 1 (page %d)" % SPECS[first]["page"],
        }
        if poses:
            entry["poses"] = {}
            for pose, n in poses.items():
                (w, h), feet = results[n]
                entry["poses"][pose] = {"file": f"chars/{key}-{pose}.png", "w": w, "h": h,
                                        "facing": SPECS[n]["facing"], "feet": feet}
        chars[key] = entry
    merge_manifest(chars)
    print("manifest updated:", MANIFEST)


if __name__ == "__main__":
    main()
