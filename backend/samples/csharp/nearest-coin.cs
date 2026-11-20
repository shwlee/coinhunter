// Single file, synchronous algorithm. 0=left, 1=up, 2=right, 3=down, -1=stay.
public class Player
{
    private int columns;
    private int turn;
    public void Initialize(int myNumber, int column, int row)
    {
        columns = column;
        turn = 0;
    }
    public string GetName() { return "C# nearest coin"; }
    public int MoveNext(int[] map, int myPosition, int[] items)
    {
        turn++;
        int[] queue = new int[map.Length];
        int[] first = new int[map.Length];
        bool[] visited = new bool[map.Length];
        int[] offsets = new int[] { -1, -columns, 1, columns };
        int head = 0;
        int tail = 1;
        queue[0] = myPosition;
        first[myPosition] = -1;
        visited[myPosition] = true;
        while (head < tail)
        {
            int position = queue[head++];
            if (position != myPosition && map[position] > 0)
            {
                if (turn % 10 == 1) Debug.Print(position);
                return first[position];
            }
            for (int direction = 0; direction < 4; direction++)
            {
                if (direction == 0 && position % columns == 0) continue;
                if (direction == 2 && position % columns == columns - 1) continue;
                int next = position + offsets[direction];
                if (next < 0 || next >= map.Length || map[next] == -1 || visited[next]) continue;
                visited[next] = true;
                first[next] = position == myPosition ? direction : first[position];
                queue[tail++] = next;
            }
        }
        return -1;
    }
}
